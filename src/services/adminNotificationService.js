import { getMessaging } from "firebase-admin/messaging";

import firebaseApp, { db, FieldValue } from "../config/firebase.js";

/*
|--------------------------------------------------------------------------
| Tell admins a new listing is waiting for review
|--------------------------------------------------------------------------
|
| Every upload is created as status "pending" and stays off the storefront
| until an admin approves it — but nothing told admins one had arrived, so
| listings could sit unreviewed indefinitely.
|
| Each active admin gets an in-app notification (on their admin
| notifications screen) and a push to their signed-in devices.
|
| Written to the shared `notifications` collection in the same shape the
| payment service uses, with audience "ADMIN", so the app files it under the
| admin account and a tapped push asks the user to sign in as admin. The
| push sending mirrors the payment service's pushService.js: one send() per
| device over FCM's HTTP v1 API, removing tokens for uninstalled apps.
|
| Nothing here may ever fail an upload: the listing is already saved, and a
| notification problem must not make the seller think it wasn't.
|
|--------------------------------------------------------------------------
*/

const ANDROID_NOTIFICATION_CHANNEL_ID = "biashnet_default";

const INACTIVE_ADMIN_STATUSES = ["inactive", "disabled", "suspended", "removed"];

const DEAD_TOKEN_CODES = [
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered"
];

export async function activeAdminUids() {
  const snapshot = await db.collection("admins").get();
  const uids = new Set();

  snapshot.forEach((doc) => {
    const admin = doc.data() || {};

    if (INACTIVE_ADMIN_STATUSES.includes(String(admin.status || "").toLowerCase())) {
      return;
    }

    // Standalone admin records carry the sign-in uid in `userId`.
    uids.add(admin.userId || doc.id);
  });

  return [...uids];
}

async function pushToUser(userId, { title, message, data }) {
  const userSnap = await db.collection("users").doc(userId).get();
  const tokens = userSnap.exists ? userSnap.data().fcmTokens || [] : [];

  if (!Array.isArray(tokens) || tokens.length === 0) return;

  const results = await Promise.allSettled(
    tokens.map((token) =>
      getMessaging(firebaseApp).send({
        token,
        notification: { title, body: message },
        // FCM only accepts string values in data.
        data: Object.fromEntries(
          Object.entries(data)
            .filter(([, value]) => value !== undefined && value !== null && value !== "")
            .map(([key, value]) => [key, String(value)])
        ),
        android: {
          priority: "high",
          notification: { channelId: ANDROID_NOTIFICATION_CHANNEL_ID }
        }
      })
    )
  );

  const deadTokens = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;

    if (DEAD_TOKEN_CODES.includes(result.reason?.code)) {
      deadTokens.push(tokens[index]);
      return;
    }

    console.error("Admin push rejected by FCM:", userId, result.reason?.code || "", result.reason?.message);
  });

  if (deadTokens.length > 0) {
    await db
      .collection("users")
      .doc(userId)
      .update({ fcmTokens: FieldValue.arrayRemove(...deadTokens) })
      .catch(() => {});
  }
}

/*
 * `recipients` defaults to every active admin. It can be given explicitly
 * so the notification can be exercised without messaging real admins.
 */
export async function notifyAdminsOfPendingProduct({ productId, title, price, sellerName, edited = false, recipients }) {
  const admins = Array.isArray(recipients) ? recipients : await activeAdminUids();

  if (admins.length === 0) return { notified: 0 };

  const listing = String(title || "").trim() || "A product";
  const amount = Number(price) || 0;
  const seller = String(sellerName || "").trim() || "A seller";
  const priced = `(KES ${amount.toLocaleString("en-KE")})`;

  // An edit to a reviewed listing takes it off the storefront until approved.
  const notificationTitle = edited ? "Edited listing to review" : "New listing to review";
  const message = edited
    ? `${seller} changed "${listing}" ${priced}. It's hidden from buyers until you review the changes.`
    : `${seller} uploaded "${listing}" ${priced}. Review it before it appears on Biashnet.`;

  const type = "PRODUCT_PENDING_REVIEW";

  const results = await Promise.allSettled(
    admins.map(async (userId) => {
      const ref = db.collection("notifications").doc();

      await ref.set({
        notificationId: ref.id,
        userId,
        type,
        audience: "ADMIN",
        title: notificationTitle,
        message,
        productId,
        data: { productId, action: "REVIEW_PRODUCT", audience: "ADMIN" },
        read: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

      await pushToUser(userId, {
        title: notificationTitle,
        message,
        data: { notificationId: ref.id, audience: "ADMIN", type, productId }
      }).catch((error) => console.error("Admin push failed:", userId, error.message));
    })
  );

  const failed = results.filter((result) => result.status === "rejected");

  failed.forEach((result) => console.error("Admin notification failed:", result.reason?.message));

  return { notified: admins.length - failed.length, failed: failed.length };
}
