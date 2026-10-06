import { randomUUID } from "node:crypto";

import { db, FieldValue } from "../config/firebase.js";
import { notifyAdminsOfPendingProduct } from "./adminNotificationService.js";
import { isPolicyReviewEnabled, reviewListing } from "./policyReviewService.js";

const productsRef = db.collection("products");

/*
|--------------------------------------------------------------------------
| Automatic first-pass review
|--------------------------------------------------------------------------
| A new or edited listing is saved as "pending" and then read against the
| seller listing policy (services/policyReviewService.js). A listing that
| meets it goes live on its own; anything else waits for an admin, who gets
| the reasons with the notification.
|
| Saved first, checked after. The seller's upload must not wait on a model,
| and an outage must never fail an upload — so if the check never finishes,
| the listing simply stays pending, which is exactly where it used to sit.
|
| Nothing here can reject a listing. Only an admin can.
*/

/*
 * Stamped on the listing when a check starts, and checked again before the
 * verdict is written. Without it a slow verdict could land after an admin
 * had already decided, or after the seller's next edit, and quietly undo it.
 */
function reviewTicket() {
  return randomUUID();
}

async function applyVerdict(productId, ticket, verdict) {
  const docRef = productsRef.doc(productId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(docRef);

    if (!snapshot.exists) return { applied: false, reason: "deleted" };

    const current = snapshot.data() || {};

    /*
     * A newer check has started — the seller edited again while this one was
     * running — so this verdict is about text and photos that are gone.
     */
    if (current.policyReview?.ticket !== ticket) {
      return { applied: false, reason: "superseded" };
    }

    /*
     * An admin got there first. Their decision stands.
     */
    if (String(current.status || "").toLowerCase() !== "pending") {
      return { applied: false, reason: "already decided" };
    }

    const policyReview = {
      ticket,
      decision: verdict.decision,
      reasons: verdict.reasons,
      summary: verdict.summary || "",
      model: verdict.model || null,
      interactionId: verdict.interactionId || null,
      failed: Boolean(verdict.failed),
      checkedAt: FieldValue.serverTimestamp(),
    };

    const updates = { policyReview, updatedAt: FieldValue.serverTimestamp() };

    if (verdict.decision === "approve") {
      updates.status = "approved";
      updates.reviewedBy = "ai";
      updates.reviewedAt = FieldValue.serverTimestamp();

      /*
       * Clears the note from an earlier rejection: the seller fixed it.
       */
      updates.reviewNote = null;
    }

    transaction.set(docRef, updates, { merge: true });

    return { applied: true, decision: verdict.decision };
  });
}

/*
 * Runs after the upload has already been answered. Never awaited, never
 * throws — a failure here leaves the listing pending for an admin, which is
 * the safe outcome.
 */
async function startPolicyReview(productId, ticket, listing, { edited = false } = {}) {
  const verdict = await reviewListing(listing);

  const outcome = await applyVerdict(productId, ticket, verdict);

  if (!outcome.applied) {
    console.log(`Policy review for ${productId} discarded (${outcome.reason}).`);
    return;
  }

  if (verdict.decision === "approve") {
    console.log(`Policy review approved ${productId}; it is live.`);
    return;
  }

  await notifyAdminsOfPendingProduct({
    productId,
    title: listing.title || listing.name,
    price: listing.price,
    sellerName: listing.sellerName,
    edited,
    reasons: verdict.reasons,
  });
}

function queuePolicyReview(productId, ticket, listing, options) {
  startPolicyReview(productId, ticket, listing, options).catch((error) =>
    console.error(`Policy review for ${productId} failed outright:`, error.message)
  );
}

/*
|--------------------------------------------------------------------------
| Re-review on edit
|--------------------------------------------------------------------------
| Every uploaded photo and every piece of text a buyer reads must meet the
| seller listing policy (public/seller-listing-policy.html in the frontend),
| so changing any of these on a listing that has already been reviewed sends
| it back to "pending".
|
| Price and stock are numbers set by the seller's own trading, not content,
| so changing them keeps the listing live. Deleting a listing needs no review.
*/

const REVIEW_FIELDS = [
  "name",
  "title",
  "description",
  "category",
  "subCategory",
  "condition",
  "location",
  "images",
];

const RE_REVIEW_STATUSES = ["approved", "active", "rejected"];

/*
 * Images are compared by their Cloudinary public_id, so the same photos sent
 * back in a different JSON shape don't count as a change. Order is kept:
 * swapping which photo comes first changes the listing's cover image.
 */
function imageSignature(images) {
  return JSON.stringify(
    (Array.isArray(images) ? images : []).map((image) =>
      typeof image === "string"
        ? image
        : image?.public_id || image?.original || image?.full || JSON.stringify(image)
    )
  );
}

function sameFieldValue(field, next, current) {
  if (field === "images") {
    return imageSignature(next) === imageSignature(current);
  }

  return String(next ?? "").trim() === String(current ?? "").trim();
}

function changedReviewFields(updates, existing) {
  return REVIEW_FIELDS.filter(
    (field) => field in updates && !sameFieldValue(field, updates[field], existing[field])
  );
}

/*
|--------------------------------------------------------------------------
| Basic English stopwords to exclude from keyword extraction
|--------------------------------------------------------------------------
*/

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "of", "in", "on",
  "to", "is", "are", "new", "used", // "new"/"used" excluded here since condition is added separately
]);

function slugify(text) {
  return (text || "")
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function buildKeywords({ title, category, subCategory, condition, location }) {
  const titleWords = (title || "")
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]/g, ""))
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));

  const extra = [category, condition, location]
    .filter(Boolean)
    .map((value) => value.toString().toLowerCase().trim());

  return Array.from(
    new Set([...titleWords, ...extra].filter(Boolean))
  );
}

export const productService = {
  async create(data, seller) {
    if (!seller?.id) {
      const error = new Error("Seller information is missing.");
      error.statusCode = 401;
      throw error;
    }

    /*
    |--------------------------------------------------------------------------
    | Images are already uploaded to Cloudinary by productController.create.
    | This service only expects the final image URLs/objects in data.images.
    |--------------------------------------------------------------------------
    */

    const images = data.images || [];

    if (!images.length) {
      const error = new Error("At least one product image is required.");
      error.statusCode = 400;
      throw error;
    }

    /*
    |--------------------------------------------------------------------------
    | Pricing
    |--------------------------------------------------------------------------
    */

    const title = data.title || data.name || "";

    const price = Number(data.price) || 0;
    const markedPrice = Number(data.oldPrice || data.markedPrice) || 0;

    const discount =
      markedPrice > price && markedPrice > 0
        ? Math.round(((markedPrice - price) / markedPrice) * 100)
        : 0;

    /*
    |--------------------------------------------------------------------------
    | Keywords (used for search)
    |--------------------------------------------------------------------------
    */

    const keywords = buildKeywords({
      title,
      category: data.category,
      condition: data.condition,
      location: data.location,
    });

    /*
     * Without an API key there is no automatic check, and the flow is
     * exactly what it was before this existed: pending, and an admin is
     * told. Local development and a lapsed key both land here.
     */
    const reviewEnabled = isPolicyReviewEnabled();

    /*
    |--------------------------------------------------------------------------
    | Build Firestore product
    |--------------------------------------------------------------------------
    */

    const productData = {
      name: data.name || "",
      title,

      category: data.category || "",
      subCategory: data.subCategory || "",

      price,
      markedPrice,
      discount,

      description: data.description || "",

      location: data.location || "",
      condition: data.condition || "",

      stock: Number(data.stock) || 0,

      images,

      keywords,
      seoSlug: slugify(title),

      /*
      |--------------------------------------------------------------------------
      | IMPORTANT
      |--------------------------------------------------------------------------
      | Never take userId/seller contact info from the frontend.
      | It comes from verifySeller (the verified main-API user record).
      */

      userId: seller.id,
      sellerName: seller.name || seller.businessName || seller.email || "",
      sellerPhone: seller.phone || "",
      sellerWhatsapp: seller.whatsapp || seller.phone || "",
      sellerPhoto: seller.photo || "",

      /*
       * Always saved pending, whatever the automatic check later decides.
       * Nothing is ever visible to buyers before it has been read by
       * something, and a crash between the save and the verdict leaves the
       * listing waiting for an admin rather than live and unchecked.
       */
      status: "pending",
      isActive: true,

      policyReview: reviewEnabled
        ? { ticket: reviewTicket(), decision: "checking", reasons: [], summary: "" }
        : null,

      promotion: {
        promoted: false,
        promotedAt: null,
        plan: null,
      },

      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),

      views: 0,
      rating: 0,
      reviewCount: 0,
    };

    /*
    |--------------------------------------------------------------------------
    | Save directly to Firestore
    |--------------------------------------------------------------------------
    */

    const docRef = await productsRef.add(productData);

    const snapshot = await docRef.get();

    /*
    |--------------------------------------------------------------------------
    | Check it, or failing that tell admins there's something to review
    |--------------------------------------------------------------------------
    | Neither is awaited: reading a listing against the policy, and fanning
    | out to every admin's devices, must not slow the seller's upload
    | response — and neither failing may make a saved listing look like it
    | failed.
    |
    | Admins are told only when the check flags the listing, which is the
    | point of having it: a listing that meets the policy goes live without
    | anyone being woken for it.
    */

    if (reviewEnabled) {
      queuePolicyReview(
        snapshot.id,
        productData.policyReview.ticket,
        { ...productData, title, price },
        { edited: false }
      );
    } else if (productData.status === "pending") {
      notifyAdminsOfPendingProduct({
        productId: snapshot.id,
        title,
        price,
        sellerName: productData.sellerName,
      }).catch((error) =>
        console.error("Could not notify admins of pending product:", error.message)
      );
    }

    return {
      id: snapshot.id,
      ...snapshot.data(),
    };
  },


  async get(id) {
    const snapshot = await productsRef.doc(id).get();

    if (!snapshot.exists) {
      const error = new Error("Product not found.");
      error.statusCode = 404;
      throw error;
    }

    return {
      id: snapshot.id,
      ...snapshot.data(),
    };
  },


  async remove(id) {
    const snapshot = await productsRef.doc(id).get();

    if (!snapshot.exists) {
      const error = new Error("Product not found.");
      error.statusCode = 404;
      throw error;
    }

    await productsRef.doc(id).delete();

    return {
      id,
    };
  },


  async update(id, data, actor) {
  const docRef = productsRef.doc(id);
  const snapshot = await docRef.get();

  if (!snapshot.exists) {
    const error = new Error("Product not found.");
    error.statusCode = 404;
    throw error;
  }

  const existing = snapshot.data();
  const ownerId = existing.sellerId || existing.userId;

  if (ownerId !== actor.id) {
    const error = new Error("You do not have permission to edit this product.");
    error.statusCode = 403;
    throw error;
  }

  const updates = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (data.name !== undefined) updates.name = data.name;
  if (data.title !== undefined) updates.title = data.title;
  if (data.category !== undefined) updates.category = data.category;
  if (data.subCategory !== undefined) updates.subCategory = data.subCategory;
  if (data.price !== undefined) updates.price = Number(data.price) || 0;
  if (data.description !== undefined) updates.description = data.description;
  if (data.location !== undefined) updates.location = data.location;
  if (data.condition !== undefined) updates.condition = data.condition;
  if (data.stock !== undefined) updates.stock = Number(data.stock) || 0;
  if (data.images !== undefined) updates.images = data.images;

  if (data.oldPrice !== undefined || data.markedPrice !== undefined) {
    const markedPrice = Number(data.oldPrice ?? data.markedPrice) || 0;
    const price = updates.price ?? existing.price ?? 0;
    updates.markedPrice = markedPrice;
    updates.discount =
      markedPrice > price && markedPrice > 0
        ? Math.round(((markedPrice - price) / markedPrice) * 100)
        : 0;
  }

  /*
  |--------------------------------------------------------------------------
  | Edits that change what buyers see go back for review
  |--------------------------------------------------------------------------
  | Approval is of the listing's content. Without this a seller could get a
  | listing approved and then swap its photos or title for something that
  | would never have passed. Price and stock changes don't need a
  | moderator, so they don't trigger it — the listing stays live.
  |
  | A rejected listing that the seller fixes also goes back to "pending", so
  | it can be reconsidered instead of staying rejected.
  */

  const sendBackForReview =
    RE_REVIEW_STATUSES.includes(String(existing.status || "").toLowerCase()) &&
    changedReviewFields(updates, existing).length > 0;

  const reviewEnabled = sendBackForReview && isPolicyReviewEnabled();

  const ticket = reviewEnabled ? reviewTicket() : null;

  if (sendBackForReview) {
    updates.status = "pending";
    updates.previousStatus = existing.status;
    updates.resubmittedAt = FieldValue.serverTimestamp();

    /*
     * A new ticket retires any check still running against the old content,
     * so an edit made mid-check can't be approved on the strength of the
     * photos it replaced.
     */
    updates.policyReview = reviewEnabled
      ? { ticket, decision: "checking", reasons: [], summary: "" }
      : null;
  }

  await docRef.set(updates, { merge: true });

  const updatedSnapshot = await docRef.get();

  if (reviewEnabled) {
    /*
     * The saved record, not `updates` — an edit touching only the title must
     * still be judged alongside the photos and description it kept.
     */
    queuePolicyReview(
      id,
      ticket,
      { id, ...updatedSnapshot.data() },
      { edited: true }
    );
  } else if (sendBackForReview) {
    notifyAdminsOfPendingProduct({
      productId: id,
      title: updates.title ?? existing.title ?? updates.name ?? existing.name,
      price: updates.price ?? existing.price,
      sellerName: existing.sellerName,
      edited: true,
    }).catch((error) =>
      console.error("Could not notify admins of edited product:", error.message)
    );
  }

  return {
    id: updatedSnapshot.id,
    ...updatedSnapshot.data(),
    sentForReview: sendBackForReview,
  };
},



};