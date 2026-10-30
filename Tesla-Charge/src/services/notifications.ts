import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { doc, setDoc } from 'firebase/firestore';
import { ref, set } from 'firebase/database';
import { db, rtdb } from '@/config/firebase';

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
 * Request notification permissions and register push token in Firebase
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
    const safeToken = token.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    // Save to RTDB live push tokens list for this charger
    try {
      await set(ref(rtdb, `notifications/subscribers/${chargerId}/${safeToken}`), {
        token,
        userId: userId || 'anonymous',
        platform: Platform.OS,
        updatedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      console.warn('[Notifications] Could not save token to RTDB:', e.message);
    }

    // Save to Firestore user doc if logged in
    if (userId && userId !== 'admin_local') {
      try {
        await setDoc(doc(db, 'users', userId), { pushToken: token, updatedAt: new Date().toISOString() }, { merge: true });
      } catch (e: any) {
        console.warn('[Notifications] Could not save token to Firestore:', e.message);
      }
    }
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
