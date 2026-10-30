/**
 * Expo Push Notification Service
 * Sends remote push notifications directly to user devices via Expo Push API
 */

export async function sendPushNotification(pushTokens, { title, body, data = {} }) {
  if (!pushTokens || pushTokens.length === 0) return;

  const validTokens = pushTokens.filter(
    (t) => typeof t === "string" && (t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken["))
  );

  if (validTokens.length === 0) return;

  const messages = validTokens.map((to) => ({
    to,
    sound: "default",
    title,
    body,
    data,
    priority: "high",
    channelId: "charging-status",
  }));

  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json();
    console.log(`[Push Notification] Sent "${title}" to ${validTokens.length} device(s):`, result?.data?.[0]?.status || "OK");
  } catch (err) {
    console.error("[Push Notification Error]:", err.message);
  }
}
