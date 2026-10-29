import { ref, update } from 'firebase/database';
import { doc, setDoc, addDoc, collection, onSnapshot, getDocs } from 'firebase/firestore';
import { rtdb, db, livePath } from '@/config/firebase';
import {
  saveLocalConnectorData,
  saveLocalActiveTx,
} from './storage';

export type LimitMode = 'full' | 'time' | 'energy' | 'price';

export interface ChargingLimit {
  mode: LimitMode;
  targetValue: number; // minutes for time, kWh for energy, PKR for price, 100 for full
  targetKwh?: number | null;
}

export interface ControlUserInfo {
  uid: string;
  email: string;
  displayName?: string | null;
}

/**
 * Dispatches an OCPP command and waits for real-time confirmation from the charger.
 * If the station does not respond within attemptTimeoutMs, it automatically retries.
 */
export async function dispatchCommandWithConfirmation(
  commandData: {
    chargePointId: string;
    action: string;
    connectorId: number;
    userId: string;
    userEmail: string;
    [key: string]: any;
  },
  maxAttempts: number = 2,
  attemptTimeoutMs: number = 10000
): Promise<{ success: boolean; result?: any; error?: string }> {
  let lastError = 'Station did not respond in time.';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const now = new Date();
      const payload = {
        ...commandData,
        attempt,
        maxAttempts,
        status: 'pending',
        createdAt: now.toISOString(),
      };

      const cmdRef = await addDoc(collection(db, 'commands'), payload);
      console.log(`[Control] Queued ${commandData.action} (attempt ${attempt}/${maxAttempts}) [${cmdRef.id}]`);

      // Real-time listener for charger / server confirmation
      const res = await new Promise<{ success: boolean; result?: any; error?: string }>((resolve) => {
        let timer: any = null;
        let resolved = false;

        const unsubscribe = onSnapshot(
          doc(db, 'commands', cmdRef.id),
          (snap) => {
            if (!snap.exists() || resolved) return;
            const data = snap.data();

            if (data.status === 'completed') {
              resolved = true;
              if (timer) clearTimeout(timer);
              unsubscribe();
              const result = data.result || {};

              if (result.status === 'Rejected') {
                resolve({
                  success: false,
                  error: result.error || 'Station rejected the command. Ensure vehicle cable is connected properly.',
                });
              } else if (result.status === 'UnlockFailed') {
                resolve({
                  success: false,
                  error: 'Station could not release cable latch. Push plug firmly in and retry.',
                });
              } else {
                resolve({ success: true, result });
              }
            } else if (data.status === 'failed') {
              resolved = true;
              if (timer) clearTimeout(timer);
              unsubscribe();
              resolve({
                success: false,
                error: data.error || 'Command failed at station.',
              });
            }
          },
          (err) => {
            if (resolved) return;
            resolved = true;
            if (timer) clearTimeout(timer);
            unsubscribe();
            resolve({ success: false, error: err.message });
          }
        );

        timer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          unsubscribe();
          resolve({
            success: false,
            error: `Station took longer than ${attemptTimeoutMs / 1000}s to respond (attempt ${attempt}/${maxAttempts}).`,
          });
        }, attemptTimeoutMs);
      });

      if (res.success) {
        return res;
      }

      lastError = res.error || lastError;

      // Do NOT retry if the charger explicitly rejected or interlock triggered
      if (
        res.error &&
        (res.error.toLowerCase().includes('reject') ||
          res.error.toLowerCase().includes('interlock') ||
          res.error.toLowerCase().includes('already'))
      ) {
        return res;
      }

      // Small delay before retry
      if (attempt < maxAttempts) {
        console.warn(`[Control] Retrying command ${commandData.action} in 1.2s...`);
        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch (err: any) {
      lastError = err.message;
    }
  }

  return { success: false, error: lastError };
}

/**
 * Send Remote Start Transaction command to the charger and wait for charger confirmation
 */
export async function startChargingSession(
  chargerId: string,
  connectorId: 1 | 2,
  limit: ChargingLimit,
  tariffRate: number = 125.0,
  user?: ControlUserInfo | null
): Promise<{ success: boolean; transactionId?: number; error?: string }> {
  const cleanId = chargerId?.trim().toLowerCase() || 'charger1';
  const now = new Date();
  const txId = Date.now();

  let computedTargetKwh: number | null = null;
  let targetPrice: number | null = null;
  let targetMinutes: number | null = null;
  const effectiveRate = tariffRate && tariffRate > 0 ? tariffRate : 125.0;
  if (limit.mode === 'energy') {
    computedTargetKwh = limit.targetValue;
  } else if (limit.mode === 'price') {
    targetPrice = limit.targetValue;
    computedTargetKwh = Number((limit.targetValue / effectiveRate).toFixed(3));
  } else if (limit.mode === 'time') {
    targetMinutes = limit.targetValue;
    computedTargetKwh = Number(((11 * limit.targetValue) / 60).toFixed(2));
  }

  // Check if driver has an authorized RFID card registered for this station
  let sessionTag = '73D8030E';
  try {
    const rfidSnap = await getDocs(collection(db, 'chargers', cleanId, 'rfidTags'));
    if (!rfidSnap.empty) {
      const match = rfidSnap.docs.find((d: any) => {
        const data = d.data();
        return data.status === 'Accepted' && (data.createdBy === user?.email || data.userId === user?.uid);
      }) || rfidSnap.docs[0];
      if (match && match.id) {
        sessionTag = match.id;
      }
    } else {
      const authSnap = await getDocs(collection(db, 'authorizedTags'));
      if (!authSnap.empty) {
        sessionTag = authSnap.docs[0].id;
      }
    }
  } catch {}

  const txData = {
    transactionId: txId,
    connectorId,
    idTag: sessionTag,
    userId: user?.uid || 'driver_user',
    userEmail: user?.email || 'driver@example.com',
    chargePointId: cleanId,
    startTime: now.toISOString(),
    meterStart: 0,
    energyDeliveredKwh: 0.0,
    limitType: limit.mode,
    limitMode: limit.mode,
    limitValue: limit.targetValue,
    targetPrice,
    targetMinutes,
    targetKwh: computedTargetKwh,
    tariffRate,
    status: 'Charging',
  };

  // Pre-seed RTDB and local cache with target limits BEFORE dispatch so server has immediate context on StartTransaction
  try {
    await update(ref(rtdb), {
      [livePath(cleanId, 'activeTx', String(connectorId))]: txData,
      [livePath(cleanId, 'connectors', String(connectorId), 'activeTx')]: txData,
    });
  } catch (_preErr) {}

  // 1. Dispatch command and wait for physical charger confirmation (with automatic retry)
  const confirmation = await dispatchCommandWithConfirmation(
    {
      chargePointId: cleanId,
      action: 'RemoteStartTransaction',
      connectorId,
      userId: user?.uid || 'driver_user',
      userEmail: user?.email || 'driver@example.com',
      idTag: sessionTag,
      targetKwh: computedTargetKwh,
      targetPrice,
      targetMinutes,
      limitMode: limit.mode,
      limitValue: limit.targetValue,
    },
    2, // 2 attempts
    10000 // 10s per attempt
  );

  if (!confirmation.success) {
    return { success: false, error: confirmation.error || 'Station did not confirm start.' };
  }

  // 2. Physical charger confirmed start! Update connector state
  try {
    await setDoc(
      doc(db, 'chargers', cleanId, 'connectors', String(connectorId)),
      {
        connectorId,
        status: 'Charging',
        activeTx: txData,
        updatedAt: now.toISOString(),
      },
      { merge: true }
    );
    await setDoc(
      doc(db, 'chargers', cleanId),
      {
        [`connector_${connectorId}_status`]: 'Charging',
        updatedAt: now.toISOString(),
      },
      { merge: true }
    );
  } catch (fsErr: any) {
    console.warn('[Control] Firestore start sync notice:', fsErr.message);
  }

  // 3. Cache locally
  await saveLocalConnectorData(cleanId, String(connectorId), {
    connectorId,
    status: 'Charging',
    activeTx: txData,
  });
  await saveLocalActiveTx(cleanId, txData);

  return { success: true, transactionId: txId };
}

/**
 * Send Remote Stop Transaction command to the charger and wait for charger confirmation
 */
export async function stopChargingSession(
  chargerId: string,
  connectorId: 1 | 2,
  activeTx?: any,
  user?: ControlUserInfo | null
): Promise<{ success: boolean; error?: string }> {
  const cleanId = chargerId?.trim().toLowerCase() || 'charger1';
  const now = new Date();

  // Determine real numeric OCPP transaction ID
  const isRealOcppTx = activeTx?.transactionId && Number(activeTx.transactionId) < 1000000000000;
  const targetTxId = isRealOcppTx ? Number(activeTx.transactionId) : null;

  // 1. Dispatch command and wait for physical charger confirmation (with automatic retry)
  const confirmation = await dispatchCommandWithConfirmation(
    {
      chargePointId: cleanId,
      action: 'RemoteStopTransaction',
      connectorId,
      userId: user?.uid || activeTx?.userId || 'driver_user',
      userEmail: user?.email || activeTx?.userEmail || 'driver@example.com',
      ...(targetTxId ? { transactionId: targetTxId } : {}),
    },
    2, // 2 attempts
    10000 // 10s per attempt
  );

  if (!confirmation.success) {
    return { success: false, error: confirmation.error || 'Station did not confirm stop.' };
  }

  // 2. Physical charger confirmed stop! Mark connector as Finishing
  try {
    await setDoc(
      doc(db, 'chargers', cleanId, 'connectors', String(connectorId)),
      {
        connectorId,
        status: 'Finishing',
        updatedAt: now.toISOString(),
      },
      { merge: true }
    );
    await setDoc(
      doc(db, 'chargers', cleanId),
      {
        [`connector_${connectorId}_status`]: 'Finishing',
        updatedAt: now.toISOString(),
      },
      { merge: true }
    );
  } catch (fsErr: any) {
    console.warn('[Control] Firestore stop status sync note:', fsErr.message);
  }

  // 3. Update local cache
  await saveLocalConnectorData(cleanId, String(connectorId), {
    connectorId,
    status: 'Finishing',
    activeTx: activeTx || null,
  });

  return { success: true };
}

/**
 * Remotely unlock the charging cable connector and wait for charger confirmation
 */
export async function unlockConnector(
  chargerId: string,
  connectorId: 1 | 2 = 1,
  user?: ControlUserInfo | null
): Promise<{ success: boolean; error?: string }> {
  const cleanId = chargerId?.trim().toLowerCase() || 'charger1';

  // 1. Dispatch command and wait for physical charger confirmation (with automatic retry)
  const confirmation = await dispatchCommandWithConfirmation(
    {
      chargePointId: cleanId,
      action: 'UnlockConnector',
      connectorId,
      userId: user?.uid || 'driver_user',
      userEmail: user?.email || 'driver@example.com',
    },
    2, // 2 attempts
    8000 // 8s per attempt
  );

  if (!confirmation.success) {
    return { success: false, error: confirmation.error || 'Station did not confirm cable unlock.' };
  }

  return { success: true };
}
