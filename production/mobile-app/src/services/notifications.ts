import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { apiRequest } from '@/config/api';
import { firebaseConfig } from '@/config/firebase';

const DEFAULT_EAS_PROJECT_ID = 'f87c91ae-f185-4d81-a797-ad303bf0d8b9';

// Configure notification behavior when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
    priority: Notifications.AndroidNotificationPriority.HIGH,
  }),
});

/**
 * Request notification permissions and register push token directly with server and Firestore
 */
export async function registerForPushNotificationsAsync(userId?: string, chargerId: string = 'charger1') {
  let token: string | null = null;
  const cleanId = (chargerId || 'charger1').trim().toLowerCase();

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('charging-status', {
      name: 'Charging Status & Alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#0284C7',
      sound: 'default',
    });
  }

  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('[Notifications] Permission not granted for push notifications.');
      return null;
    }

    if (Device.isDevice) {
      try {
        const projectId =
          Constants.expoConfig?.extra?.eas?.projectId ??
          Constants.easConfig?.projectId ??
          DEFAULT_EAS_PROJECT_ID;

        const pushTokenData = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
        token = pushTokenData.data;
        console.log('[Notifications] Expo Push Token obtained:', token);
      } catch (err: any) {
        console.warn('[Notifications] Error getting push token:', err.message);
      }
    } else {
      console.log('[Notifications] Must use physical device for remote push notifications.');
    }
  } catch (permErr: any) {
    console.warn('[Notifications] Permission check error:', permErr.message);
  }

  if (token) {
    // 1. Send to server backend
    try {
      await apiRequest('/api/notifications/register-token', {
        method: 'POST',
        body: {
          token,
          chargerId: cleanId,
          userId: userId || 'anonymous',
          platform: Platform.OS,
        },
      });
    } catch (_e) {}

    // 2. Direct Firestore fallback persistence so server can always reach this device
    try {
      if (userId && userId !== 'admin_local' && userId !== 'anonymous') {
        const userUrl = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/users/${encodeURIComponent(
          userId
        )}?updateMask.fieldPaths=pushToken&updateMask.fieldPaths=pushTokenUpdatedAt&updateMask.fieldPaths=defaultChargerId`;
        fetch(userUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              pushToken: { stringValue: token },
              pushTokenUpdatedAt: { stringValue: new Date().toISOString() },
              defaultChargerId: { stringValue: cleanId },
            },
          }),
        }).catch(() => {});
      }

      const chargerUrl = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/chargers/${encodeURIComponent(
        cleanId
      )}?updateMask.fieldPaths=lastPushToken&updateMask.fieldPaths=lastPushTokenUpdatedAt`;
      fetch(chargerUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            lastPushToken: { stringValue: token },
            lastPushTokenUpdatedAt: { stringValue: new Date().toISOString() },
          },
        }),
      }).catch(() => {});
    } catch (_err) {}
  }

  return token;
}

/**
 * Trigger local notification immediately on device (works in foreground and background)
 */
export async function scheduleLocalNotification(title: string, body: string, data: any = {}) {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      if (req.status !== 'granted') return;
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data,
        sound: 'default',
        priority: Notifications.AndroidNotificationPriority.HIGH,
      },
      trigger: null, // Send immediately
    });
    console.log(`[Notification] Fired: "${title}" - "${body}"`);
  } catch (err: any) {
    console.warn('[Notifications] Error scheduling local notification:', err.message);
  }
}

