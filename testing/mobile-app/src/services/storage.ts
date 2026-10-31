import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiRequest } from '@/config/api';

const PREFIX = '@tesla_charge_';

const KEYS = {
  CHARGER: (id: string) => `${PREFIX}charger_${id.toLowerCase()}`,
  CONNECTOR: (id: string, connId: string) => `${PREFIX}conn_${id.toLowerCase()}_${connId}`,
  ACTIVE_TX: (id: string) => `${PREFIX}active_tx_${id.toLowerCase()}`,
  TRANSACTIONS: (id: string, userId?: string) =>
    userId ? `${PREFIX}txs_${id.toLowerCase()}_${userId}` : `${PREFIX}txs_${id.toLowerCase()}`,
  LAST_SYNC: (id: string, userId?: string) =>
    userId ? `${PREFIX}last_sync_${id.toLowerCase()}_${userId}` : `${PREFIX}last_sync_${id.toLowerCase()}`,
};

// ==========================================
// 1. Charger & Connector Local Storage
// ==========================================

export async function saveLocalChargerData(chargerId: string, data: any): Promise<void> {
  if (!chargerId || !data) return;
  try {
    await AsyncStorage.setItem(KEYS.CHARGER(chargerId), JSON.stringify(data));
  } catch (err) {
    console.warn('[Storage] saveLocalChargerData error:', err);
  }
}

export async function getLocalChargerData(chargerId: string): Promise<any | null> {
  if (!chargerId) return null;
  try {
    const raw = await AsyncStorage.getItem(KEYS.CHARGER(chargerId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function saveLocalConnectorData(chargerId: string, connId: string, data: any): Promise<void> {
  if (!chargerId || !connId || !data) return;
  try {
    await AsyncStorage.setItem(KEYS.CONNECTOR(chargerId, connId), JSON.stringify(data));
  } catch (err) {
    console.warn('[Storage] saveLocalConnectorData error:', err);
  }
}

export async function getLocalConnectorData(chargerId: string, connId: string): Promise<any | null> {
  if (!chargerId || !connId) return null;
  try {
    const raw = await AsyncStorage.getItem(KEYS.CONNECTOR(chargerId, connId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function saveLocalActiveTx(chargerId: string, tx: any): Promise<void> {
  if (!chargerId) return;
  try {
    if (tx) {
      await AsyncStorage.setItem(KEYS.ACTIVE_TX(chargerId), JSON.stringify(tx));
    } else {
      await AsyncStorage.removeItem(KEYS.ACTIVE_TX(chargerId));
    }
  } catch (err) {
    console.warn('[Storage] saveLocalActiveTx error:', err);
  }
}

export async function getLocalActiveTx(chargerId: string): Promise<any | null> {
  if (!chargerId) return null;
  try {
    const raw = await AsyncStorage.getItem(KEYS.ACTIVE_TX(chargerId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ==========================================
// 2. Transactions & Historic Data Caching
// ==========================================

const MAX_CACHED_TRANSACTIONS = 200;

export async function saveLocalTransactions(chargerId: string, txs: any[], userId?: string): Promise<void> {
  if (!chargerId) return;
  try {
    const nowIso = new Date().toISOString();
    const capped = (txs || []).slice(0, MAX_CACHED_TRANSACTIONS);
    const serialized = JSON.stringify(capped);
    await AsyncStorage.setItem(KEYS.TRANSACTIONS(chargerId, userId), serialized);
    await AsyncStorage.setItem(KEYS.LAST_SYNC(chargerId, userId), nowIso);
  } catch (err) {
    console.warn('[Storage] saveLocalTransactions error:', err);
  }
}

export async function getLocalTransactions(chargerId: string, userId?: string): Promise<any[] | null> {
  if (!chargerId) return null;
  try {
    const raw = await AsyncStorage.getItem(KEYS.TRANSACTIONS(chargerId, userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    return parsed.filter((item: any) => {
      const kwh = Number(item.energyDeliveredKwh) || 0;
      const wh = Number(item.energyDeliveredWh) || 0;
      return kwh > 0 || wh > 0;
    });
  } catch {
    return null;
  }
}

export async function getLastSyncTimestamp(chargerId: string, userId?: string): Promise<string | null> {
  if (!chargerId) return null;
  try {
    let val = userId ? await AsyncStorage.getItem(KEYS.LAST_SYNC(chargerId, userId)) : null;
    if (!val) {
      val = await AsyncStorage.getItem(KEYS.LAST_SYNC(chargerId));
    }
    return val;
  } catch {
    return null;
  }
}

export async function mergeLocalTransaction(chargerId: string, tx: any, userId?: string): Promise<any[]> {
  if (!chargerId || !tx) return [];
  try {
    const newId = String(tx.transactionId || tx.id || '').trim();
    if (!newId) {
      return (await getLocalTransactions(chargerId, userId)) || [];
    }

    const currentList = (await getLocalTransactions(chargerId, userId)) || [];
    const txMap = new Map<string, any>();
    for (const item of currentList) {
      const id = String(item.transactionId || item.id || '').trim();
      if (id) txMap.set(id, item);
    }

    const existing = txMap.get(newId) || {};
    txMap.set(newId, {
      ...existing,
      ...tx,
      id: newId,
      transactionId: tx.transactionId || existing.transactionId || newId,
    });

    const updatedList = Array.from(txMap.values());
    updatedList.sort((a, b) => {
      const timeA = new Date(a.startTime || a.createdAt || 0).getTime();
      const timeB = new Date(b.startTime || b.createdAt || 0).getTime();
      return timeB - timeA;
    });

    await saveLocalTransactions(chargerId, updatedList, userId);
    return updatedList;
  } catch (err) {
    console.warn('[Storage] mergeLocalTransaction error:', err);
    return [];
  }
}

// ==========================================
// 3. Direct Server Fetch with Local Cache Strategy
// ==========================================

export interface FetchHistoryResult {
  data: any[];
  source: 'local' | 'cloud';
  lastSyncedAt?: string | null;
}

export async function fetchTransactionsWithCacheStrategy(
  chargerId: string,
  forceRefresh: boolean = false,
  userId?: string
): Promise<FetchHistoryResult> {
  const cleanId = chargerId?.trim().toLowerCase() || 'charger1';

  // 1. Fast local cache check
  if (!forceRefresh) {
    const cached = await getLocalTransactions(cleanId, userId);
    const syncTime = await getLastSyncTimestamp(cleanId, userId);
    const isFresh = syncTime ? Date.now() - new Date(syncTime).getTime() < 2 * 60 * 1000 : false;

    if (cached && cached.length > 0 && isFresh) {
      return {
        data: cached,
        source: 'local',
        lastSyncedAt: syncTime,
      };
    }
  }

  // 2. Direct Server Query (SQLite backend)
  let fetchedList: any[] = [];
  try {
    const res = await apiRequest<{ success: boolean; transactions: any[] }>(
      `/api/transactions?chargePointId=${cleanId}&limit=${MAX_CACHED_TRANSACTIONS}`
    );
    if (res && res.transactions) {
      fetchedList = res.transactions;
    }
  } catch (err: any) {
    console.warn('[Storage Direct] fetch notice:', err.message);
  }

  // 3. Offline fallback
  if (fetchedList.length === 0) {
    const fallbackCached = await getLocalTransactions(cleanId, userId);
    if (fallbackCached && fallbackCached.length > 0) {
      const syncTime = await getLastSyncTimestamp(cleanId, userId);
      return {
        data: fallbackCached,
        source: 'local',
        lastSyncedAt: syncTime,
      };
    }
  }

  const dedupMap = new Map<string, any>();
  for (const item of fetchedList) {
    const id = String(item.transactionId || item.id || '').trim();
    if (id) dedupMap.set(id, item);
  }
  const cleanFinalData = Array.from(dedupMap.values());

  cleanFinalData.sort((a, b) => {
    const timeA = new Date(a.startTime || a.createdAt || 0).getTime();
    const timeB = new Date(b.startTime || b.createdAt || 0).getTime();
    return timeB - timeA;
  });

  await saveLocalTransactions(cleanId, cleanFinalData, userId);
  const nowIso = new Date().toISOString();

  return {
    data: cleanFinalData,
    source: 'cloud',
    lastSyncedAt: nowIso,
  };
}
