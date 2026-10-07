import { getMessaging } from "firebase-admin/messaging";

import firebaseApp, { db, FieldValue } from "../config/firebase.js";

/*
|--------------------------------------------------------------------------
| Sending a push to one person's devices
|--------------------------------------------------------------------------
|
| Shared by the admin and seller notification services, which both write an
| in-app notification and then push it. Mirrors the payment service's
| pushService.js: one send() per device over FCM's HTTP v1 API, dropping the
| tokens of apps that have been uninstalled.
|
| Nothing here may ever fail the work that triggered it. A listing is
| already saved by the time anyone is told about it, and a notification
| problem must not make a saved listing look like it failed.
|
|--------------------------------------------------------------------------
*/

const ANDROID_NOTIFICATION_CHANNEL_ID = "biashnet_default";

const DEAD_TOKEN_CODES = [
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered"
];

export async function pushToUser(userId, { title, message, data }) {
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

    console.error("Push rejected by FCM:", userId, result.reason?.code || "", result.reason?.message);
  });

  if (deadTokens.length > 0) {
    await db
      .collection("users")
      .doc(userId)
      .update({ fcmTokens: FieldValue.arrayRemove(...deadTokens) })
      .catch(() => {});
  }
}

export default pushToUser;
