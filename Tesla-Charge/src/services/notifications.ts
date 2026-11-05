import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ref, onValue } from 'firebase/database';
import { apiRequest, subscribeToLiveStatus } from '@/config/api';
import { firebaseConfig, rtdb, livePath } from '@/config/firebase';

const DEFAULT_EAS_PROJECT_ID = 'f87c91ae-f185-4d81-a797-ad303bf0d8b9';
const NOTIF_CHANNEL_ID = 'charging-status-v2';

// Configure notification behavior:
// Suppress banners while user is actively viewing the app in foreground,
// but ALWAYS display banners, sound, and lockscreen alerts when in background/closed or when forceShow is set!
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const isForeground = AppState.currentState === 'active';
    const forceShow = Boolean(notification?.request?.content?.data?.forceShow);
    const shouldShow = !isForeground || forceShow;
    return {
      shouldShowAlert: shouldShow,
      shouldShowBanner: shouldShow,
      shouldShowList: shouldShow,
      shouldPlaySound: shouldShow,
      shouldSetBadge: shouldShow,
      priority: Notifications.AndroidNotificationPriority.MAX,
    };
  },
});

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(NOTIF_CHANNEL_ID, {
      name: 'Charging Status & Alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      enableVibrate: true,
      enableLights: true,
      lightColor: '#0284C7',
      showBadge: true,
      sound: 'default',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
    });
    // Also keep legacy channel active
    await Notifications.setNotificationChannelAsync('charging-status', {
      name: 'Charging Status',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      enableVibrate: true,
      enableLights: true,
      lightColor: '#0284C7',
      showBadge: true,
      sound: 'default',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
    });
  } catch (_err) {}
}

ensureAndroidChannel();

/**
 * Request notification permissions and register push token directly with server and Firestore
 */
export async function registerForPushNotificationsAsync(userId?: string, chargerId: string = 'charger1') {
  let token: string | null = null;
  const cleanId = (chargerId || 'charger1').trim().toLowerCase();

  await ensureAndroidChannel();

  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
          allowDisplayInCarPlay: true,
          allowCriticalAlerts: false,
          provideAppNotificationSettings: true,
          allowProvisional: false,
        },
      });
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
 * Trigger local notification on device (fires whenever app is in background / screen off)
 */
export async function scheduleLocalNotification(title: string, body: string, data: any = {}) {
  // Only suppress when the user actively has the app open in foreground (unless explicitly forced)
  if (AppState.currentState === 'active' && !data?.allowInForeground) {
    return;
  }

  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      if (req.status !== 'granted') return;
    }

    await ensureAndroidChannel();

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: { ...data, forceShow: true },
        sound: 'default',
        priority: Notifications.AndroidNotificationPriority.MAX,
        ...(Platform.OS === 'android' ? { channelId: NOTIF_CHANNEL_ID } : {}),
      },
      trigger: null, // Immediate presentation
    });
    console.log(`[Notification] Fired: "${title}" - "${body}"`);
  } catch (err: any) {
    console.warn('[Notifications] Error scheduling local notification:', err.message);
  }
}

interface PersistedNotifState {
  initialized: boolean;
  status1: string;
  status2: string;
  activeTxId1: string | null;
  activeTxId2: string | null;
  lastSocMilestone1: number;
  lastSocMilestone2: number;
  lastEnergyMilestone1: number;
  lastEnergyMilestone2: number;
  lastCompletedTxId: string | null;
  wasOfflineDuringCharge: boolean;
}

/**
 * Global Background & Lockscreen Notification Monitor
 * Uses both Firebase Realtime Database WebSocket (instant push over open TCP socket)
 * and HTTP polling fallback so notifications fire reliably when the app is minimized or screen is locked.
 */
export function startBackgroundNotificationMonitor(chargerId: string = 'charger1'): () => void {
  const cleanId = (chargerId || 'charger1').trim().toLowerCase();
  const storageKey = `@tesla_bg_notif_state_v2_${cleanId}`;

  let state: PersistedNotifState = {
    initialized: false,
    status1: 'Available',
    status2: 'Available',
    activeTxId1: null,
    activeTxId2: null,
    lastSocMilestone1: 0,
    lastSocMilestone2: 0,
    lastEnergyMilestone1: 0,
    lastEnergyMilestone2: 0,
    lastCompletedTxId: null,
    wasOfflineDuringCharge: false,
  };

  let isReady = false;

  AsyncStorage.getItem(storageKey)
    .then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          state = { ...state, ...parsed };
        } catch (_e) {}
      }
      isReady = true;
    })
    .catch(() => {
      isReady = true;
    });

  function persistState() {
    AsyncStorage.setItem(storageKey, JSON.stringify(state)).catch(() => {});
  }

  function processSnapshot(payload: any) {
    if (!payload || !isReady) return;

    const live = payload.live || payload;
    const chargerObj = payload.charger || live.charger || {};
    const rawConnectors = payload.connectors || live.connectors || [];
    const connectorsList = Array.isArray(rawConnectors)
      ? rawConnectors
      : Object.values(rawConnectors || {});

    const c1: any = connectorsList.find((c: any) => Number(c?.connectorId) === 1) || {};
    const c2: any = connectorsList.find((c: any) => Number(c?.connectorId) === 2) || {};

    const activeMap = payload.activeTransactions || live.activeTransactions || live.activeTx || {};
    const singleActive = payload.activeTransaction || live.activeTransaction || null;

    const tx1 =
      c1.activeTx ||
      activeMap['1'] ||
      activeMap[1] ||
      (singleActive && Number(singleActive.connectorId || singleActive.connector_id) === 1 ? singleActive : null);

    const tx2 =
      c2.activeTx ||
      activeMap['2'] ||
      activeMap[2] ||
      (singleActive && Number(singleActive.connectorId || singleActive.connector_id) === 2 ? singleActive : null);

    const status1 = String(c1.status || (tx1?.status === 'Charging' ? 'Charging' : 'Available'));
    const status2 = String(c2.status || (tx2?.status === 'Charging' ? 'Charging' : 'Available'));

    const txId1 = tx1 && status1 === 'Charging' ? String(tx1.transactionId || tx1.transaction_id || tx1.id || '') : null;
    const txId2 = tx2 && status2 === 'Charging' ? String(tx2.transactionId || tx2.transaction_id || tx2.id || '') : null;

    const completed = payload.lastCompletedTx || live.lastCompletedTx || null;
    const completedId = completed
      ? String(completed.transactionId || completed.transaction_id || completed.id || '')
      : null;

    const soc1 = Math.round(Number(c1.telemetry?.soc || tx1?.soc || tx1?.socCurrent || 0));
    const soc2 = Math.round(Number(c2.telemetry?.soc || tx2?.soc || tx2?.socCurrent || 0));

    const kwh1 =
      Number(tx1?.energyDeliveredKwh) ||
      (Number(tx1?.energyDeliveredWh) > 0 ? Number(tx1.energyDeliveredWh) / 1000 : 0);
    const kwh2 =
      Number(tx2?.energyDeliveredKwh) ||
      (Number(tx2?.energyDeliveredWh) > 0 ? Number(tx2.energyDeliveredWh) / 1000 : 0);

    const cost1 = Math.round(Number(tx1?.cost || 0));
    const cost2 = Math.round(Number(tx2?.cost || 0));

    // First-ever baseline sync: record current state so we don't spam old events on first install
    if (!state.initialized) {
      state.initialized = true;
      state.status1 = status1;
      state.status2 = status2;
      state.activeTxId1 = txId1;
      state.activeTxId2 = txId2;
      state.lastSocMilestone1 = Math.floor(soc1 / 10) * 10;
      state.lastSocMilestone2 = Math.floor(soc2 / 10) * 10;
      state.lastEnergyMilestone1 = Math.floor(kwh1 / 10) * 10;
      state.lastEnergyMilestone2 = Math.floor(kwh2 / 10) * 10;
      state.lastCompletedTxId = completedId;
      persistState();
      return;
    }

    let changed = false;

    // 1. Gun A (Connector 1) transitions
    if (status1 !== state.status1) {
      if (status1 === 'Preparing' && state.status1 === 'Available') {
        scheduleLocalNotification('🔌 Vehicle Connected (Gun A)', 'Vehicle plugged into Gun A and ready to charge.');
      } else if (status1 === 'Faulted') {
        scheduleLocalNotification('⚠️ Gun A Fault Detected', `Gun A reported a hardware fault (${c1.errorCode || 'Check charger'}).`);
      }
      state.status1 = status1;
      changed = true;
    }

    // 2. Gun B (Connector 2) transitions
    if (status2 !== state.status2) {
      if (status2 === 'Preparing' && state.status2 === 'Available') {
        scheduleLocalNotification('🔌 Vehicle Connected (Gun B)', 'Vehicle plugged into Gun B and ready to charge.');
      } else if (status2 === 'Faulted') {
        scheduleLocalNotification('⚠️ Gun B Fault Detected', `Gun B reported a hardware fault (${c2.errorCode || 'Check charger'}).`);
      }
      state.status2 = status2;
      changed = true;
    }

    // 3. Gun A Charging Start & Milestones
    if (txId1) {
      if (txId1 !== state.activeTxId1) {
        state.activeTxId1 = txId1;
        state.lastSocMilestone1 = Math.floor(soc1 / 10) * 10;
        state.lastEnergyMilestone1 = Math.floor(kwh1 / 10) * 10;
        const socText = soc1 > 0 ? ` • Battery at ${soc1}%` : '';
        scheduleLocalNotification(
          '⚡ Charging Started (Gun A)',
          `Session #${txId1} is now charging on Gun A${socText}.`
        );
        changed = true;
      } else {
        // Check 10% SoC milestones (e.g. 20%, 30% ... 90%, 100%)
        const currentSocMilestone = Math.floor(soc1 / 10) * 10;
        if (soc1 > 0 && currentSocMilestone > state.lastSocMilestone1 && currentSocMilestone >= 20) {
          state.lastSocMilestone1 = currentSocMilestone;
          scheduleLocalNotification(
            `🔋 Gun A • ${soc1}% Charged`,
            `${kwh1.toFixed(2)} kWh delivered • PKR ${cost1.toLocaleString()}`
          );
          changed = true;
        } else if (soc1 === 0) {
          const currentEnergyMilestone = Math.floor(kwh1 / 10) * 10;
          if (currentEnergyMilestone > state.lastEnergyMilestone1 && currentEnergyMilestone >= 10) {
            state.lastEnergyMilestone1 = currentEnergyMilestone;
            scheduleLocalNotification(
              `⚡ Gun A • ${kwh1.toFixed(1)} kWh Delivered`,
              `Current session cost: PKR ${cost1.toLocaleString()}`
            );
            changed = true;
          }
        }
      }
    } else if (state.activeTxId1) {
      state.activeTxId1 = null;
      changed = true;
    }

    // 4. Gun B Charging Start & Milestones
    if (txId2) {
      if (txId2 !== state.activeTxId2) {
        state.activeTxId2 = txId2;
        state.lastSocMilestone2 = Math.floor(soc2 / 10) * 10;
        state.lastEnergyMilestone2 = Math.floor(kwh2 / 10) * 10;
        const socText = soc2 > 0 ? ` • Battery at ${soc2}%` : '';
        scheduleLocalNotification(
          '⚡ Charging Started (Gun B)',
          `Session #${txId2} is now charging on Gun B${socText}.`
        );
        changed = true;
      } else {
        const currentSocMilestone = Math.floor(soc2 / 10) * 10;
        if (soc2 > 0 && currentSocMilestone > state.lastSocMilestone2 && currentSocMilestone >= 20) {
          state.lastSocMilestone2 = currentSocMilestone;
          scheduleLocalNotification(
            `🔋 Gun B • ${soc2}% Charged`,
            `${kwh2.toFixed(2)} kWh delivered • PKR ${cost2.toLocaleString()}`
          );
          changed = true;
        } else if (soc2 === 0) {
          const currentEnergyMilestone = Math.floor(kwh2 / 10) * 10;
          if (currentEnergyMilestone > state.lastEnergyMilestone2 && currentEnergyMilestone >= 10) {
            state.lastEnergyMilestone2 = currentEnergyMilestone;
            scheduleLocalNotification(
              `⚡ Gun B • ${kwh2.toFixed(1)} kWh Delivered`,
              `Current session cost: PKR ${cost2.toLocaleString()}`
            );
            changed = true;
          }
        }
      }
    } else if (state.activeTxId2) {
      state.activeTxId2 = null;
      changed = true;
    }

    // 5. Completed Transaction Detection
    if (completedId && completedId !== state.lastCompletedTxId && completedId !== '275384' && completedId !== '72089') {
      state.lastCompletedTxId = completedId;
      const gunLabel = Number(completed.connectorId || completed.connector_id) === 2 ? 'Gun B' : 'Gun A';
      const doneKwh = Number(completed.energyDeliveredKwh ?? completed.energy_kwh ?? 0).toFixed(2);
      const doneCost = Math.round(Number(completed.cost ?? 0)).toLocaleString();
      const sStart = completed.socStart ?? completed.soc_start;
      const sStop = completed.socStop ?? completed.soc_stop;
      const socSummary =
        typeof sStart === 'number' && typeof sStop === 'number' && sStop > 0
          ? ` (${sStart}% → ${sStop}% SoC)`
          : '';

      scheduleLocalNotification(
        `✅ Charging Complete (${gunLabel})`,
        `Delivered ${doneKwh} kWh${socSummary} • Total: PKR ${doneCost}`
      );
      changed = true;
    }

    // 6. Offline / Power Loss Alert during active charging
    const isOffline =
      payload.isConnected === false ||
      String(live.status || chargerObj.status || '').toLowerCase() === 'offline';

    if (isOffline && (state.activeTxId1 || state.activeTxId2) && !state.wasOfflineDuringCharge) {
      state.wasOfflineDuringCharge = true;
      scheduleLocalNotification(
        '⚠️ Charger Connection Interrupted',
        'Charger went offline during an active charging session. Waiting for reconnect...'
      );
      changed = true;
    } else if (!isOffline && state.wasOfflineDuringCharge) {
      state.wasOfflineDuringCharge = false;
      changed = true;
    }

    if (changed) {
      persistState();
    }
  }

  // Channel 1: Real-time Firebase RTDB WebSocket listener (instant push from cloud over persistent socket)
  let unsubRtdb: (() => void) | null = null;
  try {
    const chargerRef = ref(rtdb, livePath(cleanId));
    unsubRtdb = onValue(
      chargerRef,
      (snap) => {
        if (snap.exists()) {
          processSnapshot(snap.val());
        }
      },
      () => {}
    );
  } catch (_rtdbErr) {}

  // Channel 2: Direct Server Polling fallback
  const unsubServer = subscribeToLiveStatus(cleanId, (data) => {
    processSnapshot(data);
  });

  return () => {
    if (unsubRtdb) unsubRtdb();
    unsubServer();
  };
}
