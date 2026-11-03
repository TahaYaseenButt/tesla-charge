import { apiRequest } from '@/config/api';
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
 * Dispatches an OCPP command directly to the server and waits for charger confirmation.
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
      console.log(`[Control Direct] Dispatching ${commandData.action} (attempt ${attempt}/${maxAttempts})...`);

      const res = await apiRequest('/api/commands/dispatch', {
        method: 'POST',
        body: {
          ...commandData,
          attempt,
        },
        timeoutMs: attemptTimeoutMs,
      });

      if (res && res.success) {
        return { success: true, result: res.result };
      }

      if (res && res.error) {
        lastError = res.error;
        if (
          res.error.toLowerCase().includes('reject') ||
          res.error.toLowerCase().includes('already') ||
          res.error.toLowerCase().includes('offline')
        ) {
          return { success: false, error: res.error };
        }
      }
    } catch (err: any) {
      lastError = err.message || lastError;
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  return { success: false, error: lastError };
}

/**
 * Send Remote Start Transaction command to the charger
 */
export async function startChargingSession(
  chargerId: string,
  connectorId: 1 | 2,
  limit: ChargingLimit,
  tariffRate: number = 125.0,
  user?: ControlUserInfo | null
): Promise<{ success: boolean; transactionId?: number; error?: string }> {
  const cleanId = chargerId?.trim().toLowerCase() || 'charger1';
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

  const confirmation = await dispatchCommandWithConfirmation(
    {
      chargePointId: cleanId,
      action: 'RemoteStartTransaction',
      connectorId,
      userId: user?.uid || 'driver_user',
      userEmail: user?.email || 'driver@example.com',
      targetKwh: computedTargetKwh,
      targetPrice,
      targetMinutes,
      limitMode: limit.mode,
      limitValue: limit.targetValue,
    },
    2,
    10000
  );

  if (!confirmation.success) {
    return { success: false, error: confirmation.error || 'Station did not confirm start.' };
  }

  const txData = {
    transactionId: txId,
    connectorId,
    userId: user?.uid || 'driver_user',
    userEmail: user?.email || 'driver@example.com',
    chargePointId: cleanId,
    startTime: new Date().toISOString(),
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

  await saveLocalConnectorData(cleanId, String(connectorId), {
    connectorId,
    status: 'Charging',
    activeTx: txData,
  });
  await saveLocalActiveTx(cleanId, txData);

  return { success: true, transactionId: txId };
}

/**
 * Send Remote Stop Transaction command to the charger
 */
export async function stopChargingSession(
  chargerId: string,
  connectorId: 1 | 2,
  activeTx?: any,
  user?: ControlUserInfo | null
): Promise<{ success: boolean; error?: string }> {
  const cleanId = chargerId?.trim().toLowerCase() || 'charger1';
  const isRealOcppTx = activeTx?.transactionId && Number(activeTx.transactionId) < 1000000000000;
  const targetTxId = isRealOcppTx ? Number(activeTx.transactionId) : null;

  const confirmation = await dispatchCommandWithConfirmation(
    {
      chargePointId: cleanId,
      action: 'RemoteStopTransaction',
      connectorId,
      userId: user?.uid || activeTx?.userId || 'driver_user',
      userEmail: user?.email || activeTx?.userEmail || 'driver@example.com',
      ...(targetTxId ? { transactionId: targetTxId } : {}),
    },
    2,
    10000
  );

  if (!confirmation.success) {
    return { success: false, error: confirmation.error || 'Station did not confirm stop.' };
  }

  await saveLocalConnectorData(cleanId, String(connectorId), {
    connectorId,
    status: 'Finishing',
    activeTx: activeTx || null,
  });

  return { success: true };
}

/**
 * Remotely unlock the charging cable connector
 */
export async function unlockConnector(
  chargerId: string,
  connectorId: 1 | 2 = 1,
  user?: ControlUserInfo | null
): Promise<{ success: boolean; error?: string }> {
  const cleanId = chargerId?.trim().toLowerCase() || 'charger1';

  const confirmation = await dispatchCommandWithConfirmation(
    {
      chargePointId: cleanId,
      action: 'UnlockConnector',
      connectorId,
      userId: user?.uid || 'driver_user',
      userEmail: user?.email || 'driver@example.com',
    },
    2,
    8000
  );

  if (!confirmation.success) {
    return { success: false, error: confirmation.error || 'Station did not confirm cable unlock.' };
  }

  return { success: true };
}
