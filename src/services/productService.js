import { db, FieldValue } from "../config/firebase.js";
import { notifyAdminsOfPendingProduct } from "./adminNotificationService.js";

const productsRef = db.collection("products");

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

      // NOTE: defaulting new listings to "pending" pending admin/seller
      // review workflow — change to "approved" if products should go
      // live immediately without moderation.
      status: "pending",
      isActive: true,

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
    | Tell admins there's something to review
    |--------------------------------------------------------------------------
    | Not awaited: fanning out to every admin's devices shouldn't slow the
    | seller's upload response, and a notification failure must never make a
    | saved listing look like it failed.
    */

    if (productData.status === "pending") {
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

  if (sendBackForReview) {
    updates.status = "pending";
    updates.previousStatus = existing.status;
    updates.resubmittedAt = FieldValue.serverTimestamp();
  }

  await docRef.set(updates, { merge: true });

  const updatedSnapshot = await docRef.get();

  if (sendBackForReview) {
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