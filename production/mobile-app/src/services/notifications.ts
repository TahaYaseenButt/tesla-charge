import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { apiRequest } from '@/config/api';

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
 * Request notification permissions and register push token directly with the server
 */
export async function registerForPushNotificationsAsync(userId?: string, chargerId: string = 'charger1') {
  let token: string | null = null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('charging-status', {
      name: 'Charging Status & Alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#0284C7',
      sound: 'default',
    });
  }

  if (Device.isDevice) {
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

    try {
      const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
      const pushTokenData = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      token = pushTokenData.data;
      console.log('[Notifications] Expo Push Token obtained:', token);
    } catch (err: any) {
      console.warn('[Notifications] Error getting push token:', err.message);
    }
  } else {
    console.log('[Notifications] Must use physical device for remote push notifications.');
  }

  if (token) {
    try {
      await apiRequest('/api/notifications/register-token', {
        method: 'POST',
        body: {
          token,
          chargerId,
          userId: userId || 'anonymous',
          platform: Platform.OS,
        },
      });
    } catch (_e) {}
  }

  return token;
}

/**
 * Trigger local notification immediately on device (works in foreground and background)
 */
export async function scheduleLocalNotification(title: string, body: string, data: any = {}) {
  try {
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
  } catch (err: any) {
    console.warn('[Notifications] Error scheduling local notification:', err.message);
  }
}
