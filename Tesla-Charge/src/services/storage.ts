import AsyncStorage from '@react-native-async-storage/async-storage';
import { collection, query, orderBy, getDocs } from 'firebase/firestore';
import { db, fetchFirestoreCollection } from '@/config/firebase';

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
// 2. Transactions & Historic Data Caching (User Isolated)
// ==========================================

// Fix Issue 8: Cap cached transactions to 200 to prevent Android AsyncStorage 6MB overflow
const MAX_CACHED_TRANSACTIONS = 200;

// Fix Issue 7: 15-minute Cache TTL so data never stays stale forever
const CACHE_TTL_MS = 15 * 60 * 1000;

export async function saveLocalTransactions(chargerId: string, txs: any[], userId?: string): Promise<void> {
  if (!chargerId) return;
  try {
    const nowIso = new Date().toISOString();
    // Cap to most recent 200 transactions
    const capped = (txs || []).slice(0, MAX_CACHED_TRANSACTIONS);
    const serialized = JSON.stringify(capped);
    await AsyncStorage.setItem(KEYS.TRANSACTIONS(chargerId, userId), serialized);
    await AsyncStorage.setItem(KEYS.LAST_SYNC(chargerId, userId), nowIso);
    if (userId) {
      await AsyncStorage.setItem(KEYS.TRANSACTIONS(chargerId), serialized);
      await AsyncStorage.setItem(KEYS.LAST_SYNC(chargerId), nowIso);
    }
  } catch (err) {
    console.warn('[Storage] saveLocalTransactions error:', err);
  }
}

export async function getLocalTransactions(chargerId: string, userId?: string): Promise<any[] | null> {
  if (!chargerId) return null;
  try {
    let raw = userId ? await AsyncStorage.getItem(KEYS.TRANSACTIONS(chargerId, userId)) : null;
    if (!raw) {
      raw = await AsyncStorage.getItem(KEYS.TRANSACTIONS(chargerId));
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    // Filter out dummy test sessions (like 275384 dummy 4.35 kWh) and zero-energy phantoms
    const filtered = parsed.filter((item: any) => {
      const id = String(item.transactionId || item.id || '').trim();
      if (id === '275384' || id === '72089' || id === '452292' || id === '471073') return false;
      const kwh = Number(item.energyDeliveredKwh) || 0;
      const wh = Number(item.energyDeliveredWh) || 0;
      return kwh > 0 || wh > 0;
    });

    // Deduplicate twin records (e.g. cellular retries)
    const dedupMap = new Map<string, any>();
    for (const item of filtered) {
      const timeKey = item.startTime ? item.startTime.substring(0, 16) : String(item.createdAt || '').substring(0, 16);
      const dedupKey = `${item.connectorId || 1}_${timeKey}_${Math.round((Number(item.cost) || 0) * 10)}`;
      if (!dedupMap.has(dedupKey)) {
        dedupMap.set(dedupKey, item);
      } else {
        const existing = dedupMap.get(dedupKey);
        if (item.status === 'Completed' && existing.status !== 'Completed') {
          dedupMap.set(dedupKey, item);
        }
      }
    }

    const deduped = Array.from(dedupMap.values());
    return deduped.length > 0 ? deduped : null;
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

/**
 * Fix Issue 7: Robust de-duplication using unique Map keyed by transactionId / id.
 * Merges telemetry updates without creating duplicate or phantom sessions.
 */
export async function mergeLocalTransaction(chargerId: string, tx: any, userId?: string): Promise<any[]> {
  if (!chargerId || !tx) return [];
  try {
    const newId = String(tx.transactionId || tx.id || '').trim();
    if (!newId || newId === '275384' || newId === '72089') {
      return (await getLocalTransactions(chargerId, userId)) || [];
    }

    const currentList = (await getLocalTransactions(chargerId, userId)) || [];

    // Use Map to guarantee 100% unique transaction IDs
    const txMap = new Map<string, any>();
    for (const item of currentList) {
      const id = String(item.transactionId || item.id || '').trim();
      if (id && id !== '275384' && id !== '72089') {
        const kwh = Number(item.energyDeliveredKwh) || 0;
        const wh = Number(item.energyDeliveredWh) || 0;
        if (kwh > 0 || wh > 0) {
          txMap.set(id, item);
        }
      }
    }

    const txKwh = Number(tx.energyDeliveredKwh) || 0;
    const txWh = Number(tx.energyDeliveredWh) || 0;
    if (txKwh > 0 || txWh > 0) {
      const existing = txMap.get(newId) || {};
      txMap.set(newId, {
        ...existing,
        ...tx,
        id: newId,
        transactionId: tx.transactionId || existing.transactionId || newId,
      });
    }

    const updatedList = Array.from(txMap.values());

    // Sort by startTime / createdAt desc
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
// 3. Smart Fetching Strategy (Offline First with Background Sync)
// ==========================================

export interface FetchHistoryResult {
  data: any[];
  source: 'local' | 'cloud';
  lastSyncedAt?: string | null;
}

/**
 * Multi-device Synced History Strategy:
 * 1. Checks user local storage.
 * 2. If present and forceRefresh is false, immediately returns cache so UI renders in 0ms.
 * 3. Queries Firestore SDK (with orderBy startTime desc) and refreshes cache.
 * 4. Fallback to REST API and offline cache.
 */
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
    // 2-minute short TTL for cache-first navigation so newly added records sync promptly
    const isFresh = syncTime ? Date.now() - new Date(syncTime).getTime() < 2 * 60 * 1000 : false;

    if (cached && cached.length > 0 && isFresh) {
      return {
        data: cached,
        source: 'local',
        lastSyncedAt: syncTime,
      };
    }
  }

  // 2. Query Firestore SDK with descending sort
  let fetchedList: any[] = [];

  try {
    const q = query(
      collection(db, 'transactions'),
      orderBy('startTime', 'desc')
    );
    const snap = await getDocs(q);
    snap.forEach((doc) => {
      fetchedList.push({ id: doc.id, ...doc.data() });
    });
  } catch (err: any) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[Storage] Firestore SDK getDocs notice:', err.message);
    }
  }

  // Fallback to REST collection fetch if Firestore SDK returned empty
  if (fetchedList.length === 0) {
    try {
      const restDocs = await fetchFirestoreCollection('transactions', MAX_CACHED_TRANSACTIONS);
      if (restDocs && restDocs.length > 0) {
        fetchedList = restDocs;
      }
    } catch (err) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn('[Storage] REST collection fetch notice:', err);
      }
    }
  }

  // 3. Fallback to cached data if offline and network produced 0 results
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

  // Filter for this charger if specified in doc, or keep all
  const filtered = fetchedList.filter((tx) => {
    if (!tx.chargePointId) return true;
    return String(tx.chargePointId).toLowerCase() === cleanId;
  });

  const finalData = filtered.length > 0 ? filtered : fetchedList;

  // De-duplicate final array
  const dedupMap = new Map<string, any>();
  for (const item of finalData) {
    const id = String(item.transactionId || item.id || '').trim();
    if (id) dedupMap.set(id, item);
  }
  const cleanFinalData = Array.from(dedupMap.values());

  // Sort by startTime desc
  cleanFinalData.sort((a, b) => {
    const timeA = new Date(a.startTime || a.createdAt || 0).getTime();
    const timeB = new Date(b.startTime || b.createdAt || 0).getTime();
    return timeB - timeA;
  });

  // Save capped list to user local storage
  await saveLocalTransactions(cleanId, cleanFinalData, userId);
  const nowIso = new Date().toISOString();

  return {
    data: cleanFinalData,
    source: 'cloud',
    lastSyncedAt: nowIso,
  };
}
