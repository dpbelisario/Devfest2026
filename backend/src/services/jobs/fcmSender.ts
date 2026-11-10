import type { Message, Messaging } from "firebase-admin/messaging";
import type { WarningPushMessage, WarningSender } from "./warningPush.js";

/** Android notification channel created by the app (alert/WarningPush.kt). */
export const androidWarningChannelId = "disaster_warnings";

const appName = "contour-jobs-fcm";

/**
 * Firebase Cloud Messaging sender using Application Default Credentials (the
 * Cloud Run runtime service account, which needs
 * roles/firebasecloudmessaging.admin). firebase-admin is loaded on the first
 * send, so services with delivery disabled never load it.
 * `send` resolves to the FCM message ID and rejects on any FCM error.
 */
export function createFcmSender(options: {
  projectId?: string;
}): WarningSender {
  let messaging: Promise<Messaging> | null = null;
  const load = async (): Promise<Messaging> => {
    const { applicationDefault, getApps, initializeApp } =
      await import("firebase-admin/app");
    const { getMessaging } = await import("firebase-admin/messaging");
    const app =
      getApps().find((candidate) => candidate.name === appName) ??
      initializeApp(
        {
          credential: applicationDefault(),
          ...(options.projectId ? { projectId: options.projectId } : {}),
        },
        appName,
      );
    return getMessaging(app);
  };
  return {
    async send(message: WarningPushMessage) {
      messaging ??= load().catch((error: unknown) => {
        messaging = null;
        throw error;
      });
      const client = await messaging;
      return client.send(toFcmMessage(message));
    },
  };
}

/** FCM v1 message for a topic: notification + data, Android high priority. */
export function toFcmMessage(message: WarningPushMessage): Message {
  return {
    topic: message.topic,
    notification: { title: message.title, body: message.body },
    data: message.data,
    android: {
      priority: "high",
      ttl: message.ttlSeconds * 1000,
      collapseKey: message.collapseKey,
      notification: {
        channelId: androidWarningChannelId,
        // A newer bulletin of the same type replaces the previous one in the tray.
        tag: message.collapseKey,
      },
    },
  };
}
