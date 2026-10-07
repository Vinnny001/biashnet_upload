import { db, FieldValue } from "../config/firebase.js";
import { pushToUser } from "./pushService.js";
import { buildPolicyVerdictMessage } from "./sellerNotificationMessages.js";

/*
|--------------------------------------------------------------------------
| Tell a seller what the automatic check decided
|--------------------------------------------------------------------------
|
| The check runs after the upload has already been answered, so without this
| a seller is told nothing: their listing either quietly goes live or
| quietly sits waiting, and they have no way to know which. Now the verdict
| reaches them, in the app and as a push.
|
| Written to the shared `notifications` collection in the shape the payment
| service and the main backend use, with audience "SELLER", so it lands on
| the seller notifications screen and a tapped push opens the seller
| account. The two types are ones the app already renders and routes:
| PRODUCT_APPROVED and PRODUCT_PENDING_REVIEW.
|
| The wording lives in sellerNotificationMessages.js, together with the rule
| it has to obey: a flagged listing is not a rejection, and nothing said to
| the seller may imply one.
|
|--------------------------------------------------------------------------
*/

/*
 * Returns whether the in-app notification was saved. A failed push still
 * counts: the seller sees it on their notifications screen either way.
 */
export async function notifySellerOfPolicyVerdict({ productId, listing, verdict }) {
  const sellerId = listing?.sellerId || listing?.userId;

  if (!sellerId) {
    console.warn(`Policy verdict notification skipped for ${productId}: no seller on the listing.`);
    return false;
  }

  const { type, title, message } = buildPolicyVerdictMessage({ listing, verdict });

  const ref = db.collection("notifications").doc();

  await ref.set({
    notificationId: ref.id,
    userId: sellerId,
    type,
    audience: "SELLER",
    title,
    message,
    productId,
    data: {
      productId,
      status: verdict.decision === "approve" ? "approved" : "pending",
      action: "VIEW_PRODUCT",
      audience: "SELLER",
    },
    read: false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await pushToUser(sellerId, {
    title,
    message,
    data: { notificationId: ref.id, audience: "SELLER", type, productId },
  }).catch((error) => console.error("Seller push failed:", sellerId, error.message));

  return true;
}

export default notifySellerOfPolicyVerdict;
