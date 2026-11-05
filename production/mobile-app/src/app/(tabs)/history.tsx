import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { useAuth } from '@/config/auth';

import { apiRequest, subscribeToLiveStatus } from '@/config/api';
import {
  fetchTransactionsWithCacheStrategy,
  getLocalTransactions,
  saveLocalTransactions,
  mergeLocalTransaction,
} from '@/services/storage';
import { HistorySkeleton } from '@/components/skeleton';
import { SwipeableTabScreen } from '@/components/SwipeableTabScreen';

type FilterMode = 'all' | 'today' | 'day' | 'range' | 'month';

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Helper to get exact YYYY-MM-DD and date parts in Asia/Karachi (PKT) time
function getKarachiDateParts(date: Date = new Date()): { year: number; month: number; day: number; dateStr: string } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) {
      map[p.type] = p.value;
    }
    const year = Number(map.year);
    const month = Number(map.month) - 1; // 0-indexed month
    const day = Number(map.day);
    return {
      year,
      month,
      day,
      dateStr: `${map.year}-${map.month}-${map.day}`,
    };
  } catch (_e) {
    const y = date.getFullYear();
    const m = date.getMonth();
    const d = date.getDate();
    return {
      year: y,
      month: m,
      day: d,
      dateStr: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    };
  }
}

// Helper to format Date into YYYY-MM-DD in Asia/Karachi (PKT) time
function formatDateKey(date: Date): string {
  return getKarachiDateParts(date).dateStr;
}

export default function HistoryScreen() {
  const { chargerId, user } = useAuth();
  const CHARGER_ID = (chargerId || user?.stationId || user?.defaultChargerId || 'charger1').trim().toLowerCase();

  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dataSource, setDataSource] = useState<'local' | 'cloud'>('local');
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);

  // Today parts in Asia/Karachi
  const todayParts = useMemo(() => getKarachiDateParts(), []);
  const todayKey = todayParts.dateStr;

  // Filter state
  const [filterMode, setFilterMode] = useState<FilterMode>('today');
  const [selectedDate, setSelectedDate] = useState<string>(todayKey);
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [rangeEnd, setRangeEnd] = useState<string | null>(null);

  // Calendar month view initialized to Karachi current year and month
  const [viewDate, setViewDate] = useState<Date>(() => new Date(todayParts.year, todayParts.month, 1));
  const [calendarCollapsed, setCalendarCollapsed] = useState<boolean>(false);

  // Helper to merge real-time status updates into current transactions
  const mergeLiveUpdates = useCallback((statusRes: any) => {
    if (!statusRes) return;
    const cleanId = CHARGER_ID.trim().toLowerCase();
    const live = statusRes.live || {};
    const connectors = statusRes.connectors || live.connectors || [];

    // 1. Collect all active transactions across Gun A, Gun B and root
    const activeList: any[] = [];
    if (Array.isArray(connectors)) {
      connectors.forEach((c: any) => {
        if (c?.activeTx && (c.activeTx.transactionId || c.activeTx.id)) {
          activeList.push({ ...c.activeTx, connectorId: c.connectorId || c.activeTx.connectorId || 1 });
        }
      });
    } else if (connectors && typeof connectors === 'object') {
      Object.entries(connectors).forEach(([connKey, c]: [string, any]) => {
        if (c?.activeTx && (c.activeTx.transactionId || c.activeTx.id)) {
          activeList.push({ ...c.activeTx, connectorId: Number(connKey) || c.activeTx.connectorId || 1 });
        }
      });
    }

    const singleActive = statusRes.activeTransaction || live.activeTransaction;
    if (singleActive && (singleActive.transactionId || singleActive.id)) {
      const sId = String(singleActive.transactionId || singleActive.id).trim();
      if (!activeList.some((a) => String(a.transactionId || a.id).trim() === sId)) {
        activeList.push(singleActive);
      }
    }

    // 2. Latest completed transaction
    const lastDone = statusRes.lastCompletedTx || live.lastCompletedTx;

    setTransactions((prev) => {
      let next = [...prev];
      let changed = false;

      // Real-time active charging sessions
      for (const act of activeList) {
        const actId = String(act.transactionId || act.id || '').trim();
        if (!actId) continue;

        const formatted = {
          ...act,
          id: actId,
          transactionId: act.transactionId || actId,
          connectorId: act.connectorId || 1,
          status: act.status || 'Charging',
          energyDeliveredKwh: act.energyDeliveredKwh || (act.energyDeliveredWh ? act.energyDeliveredWh / 1000 : 0) || 0,
          cost: act.cost || 0,
          socStart: typeof act.socStart === 'number' ? act.socStart : (typeof act.soc_start === 'number' ? act.soc_start : null),
          socCurrent: typeof act.socCurrent === 'number' ? act.socCurrent : (typeof act.soc === 'number' ? act.soc : null),
          socStop: null,
          startTime: act.startTime || act.createdAt || new Date().toISOString(),
          createdAt: act.createdAt || act.startTime || new Date().toISOString(),
        };

        const idx = next.findIndex((t: any) => String(t.transactionId || t.id).trim() === actId);
        if (idx >= 0) {
          if (
            next[idx].status !== formatted.status ||
            next[idx].energyDeliveredKwh !== formatted.energyDeliveredKwh ||
            next[idx].cost !== formatted.cost ||
            next[idx].socCurrent !== formatted.socCurrent ||
            next[idx].socStart !== formatted.socStart
          ) {
            next[idx] = { ...next[idx], ...formatted };
            changed = true;
          }
        } else {
          // Immediately prepend newly started session in real time!
          next.unshift(formatted);
          mergeLocalTransaction(cleanId, formatted, user?.uid);
          changed = true;
        }
      }

      // Real-time completed session
      if (lastDone && (lastDone.transactionId || lastDone.id)) {
        const doneId = String(lastDone.transactionId || lastDone.id).trim();
        if (doneId && doneId !== '275384' && doneId !== '72089') {
          const formattedDone: any = {
            ...lastDone,
            id: doneId,
            transactionId: lastDone.transactionId || doneId,
            status: 'Completed',
            energyDeliveredKwh: lastDone.energyDeliveredKwh || lastDone.energy_kwh || 0,
            cost: lastDone.cost || 0,
            socStart: typeof lastDone.socStart === 'number' ? lastDone.socStart : (typeof lastDone.soc_start === 'number' ? lastDone.soc_start : null),
            socStop: typeof lastDone.socStop === 'number' ? lastDone.socStop : (typeof lastDone.soc_stop === 'number' ? lastDone.soc_stop : null),
            socCurrent: typeof lastDone.socCurrent === 'number' ? lastDone.socCurrent : (typeof lastDone.soc_current === 'number' ? lastDone.soc_current : null),
            socGained: typeof lastDone.socGained === 'number' ? lastDone.socGained : null,
            startTime: lastDone.startTime || lastDone.start_time,
            stopTime: lastDone.stopTime || lastDone.stop_time,
          };
          if (lastDone.createdAt) {
            formattedDone.createdAt = lastDone.createdAt;
          }

          const idx = next.findIndex((t: any) => String(t.transactionId || t.id).trim() === doneId);
          if (idx >= 0) {
            const preservedCreatedAt = next[idx].createdAt && next[idx].createdAt !== next[idx].updatedAt
              ? next[idx].createdAt
              : (formattedDone.createdAt || next[idx].createdAt);
            if (next[idx].status !== 'Completed' || next[idx].socStop !== formattedDone.socStop) {
              next[idx] = { ...next[idx], ...formattedDone, ...(preservedCreatedAt ? { createdAt: preservedCreatedAt } : {}) };
              mergeLocalTransaction(cleanId, next[idx], user?.uid);
              changed = true;
            }
          } else {
            next.unshift(formattedDone);
            mergeLocalTransaction(cleanId, formattedDone, user?.uid);
            changed = true;
          }
        }
      }

      return changed ? next : prev;
    });
  }, [CHARGER_ID, user?.uid]);

  // 1. Fetch transactions with local-first cache strategy
  const loadHistory = useCallback(
    async (forceRefresh: boolean = false) => {
      if (forceRefresh) {
        setRefreshing(true);
      }
      try {
        const cleanId = CHARGER_ID.trim().toLowerCase();
        const res = await fetchTransactionsWithCacheStrategy(CHARGER_ID, forceRefresh, user?.uid);
        let list = [...(res.data || [])];

        // Also fetch live charger state to include current in-progress transactions on all guns
        try {
          const liveRes = await apiRequest<any>(`/api/chargers/${encodeURIComponent(cleanId)}/live`);
          if (liveRes) {
            // Collect all active sessions
            const activeSessions: any[] = [];
            const connectors = liveRes.connectors || [];
            if (Array.isArray(connectors)) {
              connectors.forEach((c: any) => {
                if (c?.activeTx && (c.activeTx.transactionId || c.activeTx.id)) {
                  activeSessions.push(c.activeTx);
                }
              });
            } else if (connectors && typeof connectors === 'object') {
              Object.values(connectors).forEach((c: any) => {
                if (c?.activeTx && (c.activeTx.transactionId || c.activeTx.id)) {
                  activeSessions.push(c.activeTx);
                }
              });
            }
            if (liveRes.activeTransaction && (liveRes.activeTransaction.transactionId || liveRes.activeTransaction.id)) {
              const sId = String(liveRes.activeTransaction.transactionId || liveRes.activeTransaction.id).trim();
              if (!activeSessions.some((a) => String(a.transactionId || a.id).trim() === sId)) {
                activeSessions.push(liveRes.activeTransaction);
              }
            }

            for (const active of activeSessions) {
              const activeTxId = String(active.transactionId || active.id || '').trim();
              if (activeTxId) {
                const formattedActive = {
                  ...active,
                  id: activeTxId,
                  transactionId: active.transactionId || activeTxId,
                  status: active.status || 'Charging',
                  energyDeliveredKwh: active.energyDeliveredKwh || (active.energyDeliveredWh ? active.energyDeliveredWh / 1000 : 0) || 0,
                  cost: active.cost || 0,
                  socStart: typeof active.socStart === 'number' ? active.socStart : (typeof active.soc_start === 'number' ? active.soc_start : null),
                  socCurrent: typeof active.socCurrent === 'number' ? active.socCurrent : (typeof active.soc === 'number' ? active.soc : null),
                  socStop: null,
                  startTime: active.startTime || active.createdAt || new Date().toISOString(),
                  createdAt: active.createdAt || active.startTime || new Date().toISOString(),
                };
                const idx = list.findIndex((t: any) => String(t.transactionId || t.id).trim() === activeTxId);
                if (idx >= 0) {
                  list[idx] = { ...list[idx], ...formattedActive };
                } else {
                  list.unshift(formattedActive);
                }
                mergeLocalTransaction(cleanId, formattedActive, user?.uid);
              }
            }

            // 2. Latest completed session
            const lastDone = liveRes.lastCompletedTx;
            if (lastDone && (lastDone.transactionId || lastDone.id)) {
              const doneId = String(lastDone.transactionId || lastDone.id).trim();
              if (doneId && doneId !== '275384' && doneId !== '72089') {
                const formattedDone: any = {
                  ...lastDone,
                  id: doneId,
                  transactionId: lastDone.transactionId || doneId,
                  status: 'Completed',
                  energyDeliveredKwh: lastDone.energyDeliveredKwh || lastDone.energy_kwh || 0,
                  cost: lastDone.cost || 0,
                  socStart: typeof lastDone.socStart === 'number' ? lastDone.socStart : (typeof lastDone.soc_start === 'number' ? lastDone.soc_start : null),
                  socStop: typeof lastDone.socStop === 'number' ? lastDone.socStop : (typeof lastDone.soc_stop === 'number' ? lastDone.soc_stop : null),
                  socCurrent: typeof lastDone.socCurrent === 'number' ? lastDone.socCurrent : (typeof lastDone.soc_current === 'number' ? lastDone.soc_current : null),
                  socGained: typeof lastDone.socGained === 'number' ? lastDone.socGained : null,
                  startTime: lastDone.startTime || lastDone.start_time,
                  stopTime: lastDone.stopTime || lastDone.stop_time,
                };
                if (lastDone.createdAt) {
                  formattedDone.createdAt = lastDone.createdAt;
                }
                const idx = list.findIndex((t: any) => String(t.transactionId || t.id).trim() === doneId);
                if (idx >= 0) {
                  const preservedCreatedAt = list[idx].createdAt && list[idx].createdAt !== list[idx].updatedAt
                    ? list[idx].createdAt
                    : (formattedDone.createdAt || list[idx].createdAt);
                  list[idx] = { ...list[idx], ...formattedDone, ...(preservedCreatedAt ? { createdAt: preservedCreatedAt } : {}) };
                  mergeLocalTransaction(cleanId, list[idx], user?.uid);
                } else {
                  list.unshift(formattedDone);
                  mergeLocalTransaction(cleanId, formattedDone, user?.uid);
                }
              }
            }
          }
        } catch (_liveErr) {}

        setTransactions(list);
        setDataSource(res.source);
        setLastSyncTime(res.lastSyncedAt || null);
      } catch (err) {
        console.warn('History load error:', err);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [CHARGER_ID, user?.uid]
  );

  // 2. Real-Time Server Subscription & Periodic Archive Sync
  useEffect(() => {
    let isMounted = true;
    const cleanId = CHARGER_ID.trim().toLowerCase();

    // Fast 0ms cache render
    getLocalTransactions(cleanId, user?.uid).then((cached) => {
      if (isMounted && cached && cached.length > 0) {
        setTransactions(cached);
        setDataSource('local');
        setLoading(false);
      }
    });

    // Immediate direct server fetch
    loadHistory(true);

    // High-frequency Real-Time subscription (receives live activeTx updates every 2.5s and immediately on charging events)
    const unsubLive = subscribeToLiveStatus(cleanId, (statusRes) => {
      if (isMounted) {
        mergeLiveUpdates(statusRes);
      }
    });

    // Archive refresh every 6 seconds to ensure full database sync
    const interval = setInterval(() => {
      if (isMounted) {
        loadHistory(true);
      }
    }, 6000);

    return () => {
      isMounted = false;
      unsubLive();
      clearInterval(interval);
    };
  }, [CHARGER_ID, user?.uid, loadHistory, mergeLiveUpdates]);

  // Deduplicate by transactionId
  const scopedTransactions = useMemo(() => {
    const list = transactions;

    // Deduplicate by transactionId or start minute so duplicate records never display twice
    const map = new Map<string, any>();
    for (const tx of list) {
      const txId = tx.transactionId ? String(tx.transactionId).trim() : null;
      const timeKey = tx.startTime ? tx.startTime.substring(0, 16) : String(tx.createdAt || '').substring(0, 16);
      const key = txId ? `id_${txId}` : `conn_${tx.connectorId || 1}_${timeKey}`;
      const kwh =
        Number(tx.energyDeliveredKwh) ||
        (Number(tx.energyDeliveredWh) ? Number(tx.energyDeliveredWh) / 1000 : 0) ||
        (tx.meterStop && tx.meterStart && Number(tx.meterStop) > Number(tx.meterStart)
          ? (Number(tx.meterStop) - Number(tx.meterStart)) / 1000
          : 0);

      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...tx, computedKwh: kwh });
      } else {
        const existKwh = Number(existing.computedKwh) || 0;
        const existCost = Number(existing.cost) || 0;
        const curCost = Number(tx.cost) || 0;
        const isCompleted = tx.status === 'Completed' || existing.status === 'Completed';
        const validCreatedAt =
          existing.createdAt && existing.createdAt !== existing.updatedAt
            ? existing.createdAt
            : (tx.createdAt && tx.createdAt !== tx.updatedAt ? tx.createdAt : (existing.createdAt || tx.createdAt));
        map.set(key, {
          ...existing,
          ...tx,
          ...(validCreatedAt ? { createdAt: validCreatedAt } : {}),
          status: isCompleted ? 'Completed' : (tx.status || existing.status),
          computedKwh: Math.max(kwh, existKwh),
          cost: Math.max(curCost, existCost),
          socStart: typeof tx.socStart === 'number' && tx.socStart > 0 ? tx.socStart : existing.socStart,
          socStop: typeof tx.socStop === 'number' && tx.socStop > 0 ? tx.socStop : existing.socStop,
          socGained: typeof tx.socGained === 'number' && tx.socGained > 0 ? tx.socGained : existing.socGained,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const idA = Number(a.transactionId || a.id) || 0;
      const idB = Number(b.transactionId || b.id) || 0;
      if (idA > 0 && idB > 0 && idA !== idB) {
        return idB - idA;
      }
      const timeA = new Date(a.createdAt || a.updatedAt || a.startTime || a.stopTime || 0).getTime();
      const timeB = new Date(b.createdAt || b.updatedAt || b.startTime || b.stopTime || 0).getTime();
      return timeB - timeA;
    });
  }, [transactions]);

  // 2. Map transactions to date keys (YYYY-MM-DD)
  const getTxDateKey = (tx: any): string => {
    const ts = tx.createdAt || tx.updatedAt || tx.startTime || tx.stopTime;
    if (!ts) return '';
    const d = new Date(ts);
    return isNaN(d.getTime()) ? '' : formatDateKey(d);
  };

  // 3. Pre-aggregate energy & counts per day for calendar indicators
  const { dayEnergyMap, dayCountMap } = useMemo(() => {
    const energyMap: Record<string, number> = {};
    const countMap: Record<string, number> = {};

    scopedTransactions.forEach((tx) => {
      const key = getTxDateKey(tx);
      if (!key) return;
      const kwh =
        Number(tx.computedKwh) ||
        Number(tx.energyDeliveredKwh) ||
        (Number(tx.energyDeliveredWh) ? Number(tx.energyDeliveredWh) / 1000 : 0);
      energyMap[key] = (energyMap[key] || 0) + kwh;
      countMap[key] = (countMap[key] || 0) + 1;
    });

    return { dayEnergyMap: energyMap, dayCountMap: countMap };
  }, [scopedTransactions]);

  // 4. Calendar Month Grid Calculation
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const monthName = viewDate.toLocaleString('default', { month: 'long', year: 'numeric' });

  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const prevMonth = () => {
    setViewDate(new Date(year, month - 1, 1));
  };
  const nextMonth = () => {
    setViewDate(new Date(year, month + 1, 1));
  };

  // Handle Calendar Day Tap
  const handleDayPress = (dayNum: number) => {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;

    if (filterMode === 'range') {
      if (!rangeStart || (rangeStart && rangeEnd)) {
        setRangeStart(dateStr);
        setRangeEnd(null);
      } else {
        if (dateStr < rangeStart) {
          setRangeEnd(rangeStart);
          setRangeStart(dateStr);
        } else {
          setRangeEnd(dateStr);
        }
      }
    } else {
      setSelectedDate(dateStr);
      setFilterMode(dateStr === todayKey ? 'today' : 'day');
    }
  };

  // 5. Filter Transactions Based on Active Filter
  const filteredTransactions = useMemo(() => {
    if (filterMode === 'all') {
      return scopedTransactions;
    }

    return scopedTransactions.filter((tx) => {
      const txKey = getTxDateKey(tx);
      if (!txKey) return false;

      if (filterMode === 'today') {
        return txKey === todayKey;
      }
      if (filterMode === 'day') {
        return txKey === selectedDate;
      }
      if (filterMode === 'range') {
        if (!rangeStart) return true;
        if (rangeStart && !rangeEnd) return txKey === rangeStart;
        return txKey >= (rangeStart || '') && txKey <= (rangeEnd || '');
      }
      if (filterMode === 'month') {
        const currentMonthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
        return txKey.startsWith(currentMonthPrefix);
      }
      return true;
    });
  }, [scopedTransactions, filterMode, selectedDate, rangeStart, rangeEnd, todayKey, year, month]);

  // Aggregated Summary for Active Filter
  const totalFilteredEnergy = filteredTransactions.reduce((acc, tx) => {
    const kwh =
      Number(tx.energyDeliveredKwh) ||
      (Number(tx.energyDeliveredWh) ? Number(tx.energyDeliveredWh) / 1000 : 0);
    return acc + kwh;
  }, 0);

  const activeFilterTitle = useMemo(() => {
    if (filterMode === 'all') {
      return 'All Sessions';
    }
    if (filterMode === 'today' || selectedDate === todayKey) {
      return 'Today';
    }
    if (filterMode === 'day') {
      const [y, m, d] = selectedDate.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
    if (filterMode === 'range') {
      if (rangeStart && rangeEnd) {
        return `${rangeStart} to ${rangeEnd}`;
      } else if (rangeStart) {
        return `From ${rangeStart} (Pick End Date)`;
      }
      return 'Pick Date Range';
    }
    if (filterMode === 'month') return monthName;
    return 'All Records';
  }, [filterMode, selectedDate, rangeStart, rangeEnd, monthName, todayKey]);

  const formattedSyncTime = useMemo(() => {
    if (!lastSyncTime) return null;
    try {
      const d = new Date(lastSyncTime);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return null;
    }
  }, [lastSyncTime]);

  if (loading) {
    return <HistorySkeleton />;
  }

  return (
    <SwipeableTabScreen currentTab="history">
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        nestedScrollEnabled={true}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => loadHistory(true)}
          tintColor="#0F172A"
        />
      }
    >
      {/* Screen Title */}
      <View style={styles.topHeader}>
        <Text style={styles.pageTitle}>CHARGING HISTORY</Text>
      </View>

      {/* Storage Source & Sync Bar */}
      <View style={styles.syncRow}>
        <View style={styles.syncBadge}>
          <Text style={styles.syncBadgeIcon}>
            {dataSource === 'local' ? '💾' : '☁️'}
          </Text>
          <Text style={styles.syncBadgeText}>
            {dataSource === 'local'
              ? 'Local Storage (0 DB reads)'
              : 'Synced with Cloud'}
            {formattedSyncTime ? ` • ${formattedSyncTime}` : ''}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.syncButton}
          onPress={() => loadHistory(true)}
          disabled={refreshing}
          activeOpacity={0.7}
        >
          {refreshing ? (
            <ActivityIndicator size="small" color="#0284C7" />
          ) : (
            <Text style={styles.syncButtonText}>🔄 Sync Cloud</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Filter Mode Tabs */}
      <View style={styles.filterTabsRow}>
        <TouchableOpacity
          style={[styles.filterTab, filterMode === 'all' && styles.filterTabActive]}
          onPress={() => setFilterMode('all')}
        >
          <Text style={[styles.filterTabText, filterMode === 'all' && styles.filterTabTextActive]}>
            All
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterTab, filterMode === 'today' && styles.filterTabActive]}
          onPress={() => {
            setFilterMode('today');
            setSelectedDate(todayKey);
          }}
        >
          <Text style={[styles.filterTabText, filterMode === 'today' && styles.filterTabTextActive]}>
            Today
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterTab, filterMode === 'day' && styles.filterTabActive]}
          onPress={() => setFilterMode('day')}
        >
          <Text style={[styles.filterTabText, filterMode === 'day' && styles.filterTabTextActive]}>
            Day
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterTab, filterMode === 'range' && styles.filterTabActive]}
          onPress={() => {
            setFilterMode('range');
            setRangeStart(null);
            setRangeEnd(null);
          }}
        >
          <Text style={[styles.filterTabText, filterMode === 'range' && styles.filterTabTextActive]}>
            Range
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterTab, filterMode === 'month' && styles.filterTabActive]}
          onPress={() => setFilterMode('month')}
        >
          <Text style={[styles.filterTabText, filterMode === 'month' && styles.filterTabTextActive]}>
            Month
          </Text>
        </TouchableOpacity>
      </View>

      {/* Interactive Calendar Card */}
      {!calendarCollapsed && (
        <View style={styles.calendarCard}>
          {/* Calendar Month Navigation Header */}
          <View style={styles.calendarNavHeader}>
            <TouchableOpacity onPress={prevMonth} style={styles.navArrowBtn}>
              <Text style={styles.navArrowText}>‹</Text>
            </TouchableOpacity>

            <Text style={styles.monthTitleText}>{monthName}</Text>

            <TouchableOpacity onPress={nextMonth} style={styles.navArrowBtn}>
              <Text style={styles.navArrowText}>›</Text>
            </TouchableOpacity>
          </View>

          {/* Days of Week Header */}
          <View style={styles.weekHeaderRow}>
            {DAYS_OF_WEEK.map((d, i) => (
              <Text key={i} style={styles.weekDayLabel}>
                {d}
              </Text>
            ))}
          </View>

          {/* Day Cells Grid */}
          <View style={styles.daysGrid}>
            {/* Blank leading cells */}
            {Array.from({ length: firstDayOfWeek }).map((_, i) => (
              <View key={`blank-${i}`} style={styles.dayCellEmpty} />
            ))}

            {/* Month Day Cells */}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const dayNum = i + 1;
              const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
              const isToday = dateStr === todayKey;

              const isSingleSelected =
                (filterMode === 'day' || filterMode === 'today') && selectedDate === dateStr;
              const isRangeSelected =
                filterMode === 'range' &&
                ((rangeStart && dateStr === rangeStart) ||
                  (rangeEnd && dateStr === rangeEnd) ||
                  (rangeStart && rangeEnd && dateStr >= rangeStart && dateStr <= rangeEnd));

              const isSelected = isSingleSelected || isRangeSelected;
              const dayEnergy = dayEnergyMap[dateStr] || 0;
              const hasCharging = dayEnergy > 0 || (dayCountMap[dateStr] || 0) > 0;

              return (
                <TouchableOpacity
                  key={`day-${dayNum}`}
                  style={[
                    styles.dayCell,
                    isToday && styles.dayCellToday,
                    isSelected && styles.dayCellSelected,
                  ]}
                  onPress={() => handleDayPress(dayNum)}
                >
                  <Text
                    style={[
                      styles.dayNumberText,
                      isToday && styles.dayNumberTextToday,
                      isSelected && styles.dayNumberTextSelected,
                    ]}
                  >
                    {dayNum}
                  </Text>

                  {/* Energy dot & text */}
                  {hasCharging && (
                    <View style={styles.energyIndicator}>
                      <View
                        style={[
                          styles.chargingDot,
                          isSelected && { backgroundColor: '#FFFFFF' },
                        ]}
                      />
                      <Text
                        style={[
                          styles.dayEnergyLabel,
                          isSelected && { color: '#FFFFFF' },
                        ]}
                        numberOfLines={1}
                      >
                        {dayEnergy > 0 ? `${dayEnergy.toFixed(1)}k` : '•'}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* Summary Metrics Bar for Selected Filter */}
      <View style={styles.summaryBar}>
        <View style={styles.summaryTextGroup}>
          <Text style={styles.summaryFilterLabel}>{activeFilterTitle.toUpperCase()}</Text>
          <View style={styles.summaryValuesRow}>
            <Text style={styles.summaryEnergyVal}>{totalFilteredEnergy.toFixed(1)}</Text>
            <Text style={styles.summaryEnergyUnit}>kWh</Text>
            <Text style={styles.summaryCount}>
              &bull; {filteredTransactions.length}{' '}
              {filteredTransactions.length === 1 ? 'session' : 'sessions'}
            </Text>
          </View>
        </View>

        {filterMode !== 'today' && (
          <TouchableOpacity
            style={styles.quickTodayBtn}
            onPress={() => {
              setFilterMode('today');
              setSelectedDate(todayKey);
            }}
          >
            <Text style={styles.quickTodayBtnText}>Reset Today</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Charging Sessions List */}
      <View style={styles.sessionList}>
        {filteredTransactions.length === 0 ? (
          <View style={styles.emptyCard}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#94A3B8', marginBottom: 14 }} />
            <Text style={styles.emptyTitle}>No charging sessions recorded</Text>
            <Text style={styles.emptySub}>
              {filterMode === 'today'
                ? "No sessions today yet. Tap 'Month' or pick another day in the calendar to review past history."
                : 'No charging activity found for this period.'}
            </Text>
          </View>
        ) : (
          filteredTransactions.map((tx) => {
            const isCompleted = tx.status === 'Completed' || tx.meterStop !== undefined;
            const energy =
              Number(tx.computedKwh) ||
              Number(tx.energyDeliveredKwh) ||
              (Number(tx.energyDeliveredWh) ? Number(tx.energyDeliveredWh) / 1000 : 0) ||
              (tx.meterStop && tx.meterStart && Number(tx.meterStop) > Number(tx.meterStart)
                ? (Number(tx.meterStop) - Number(tx.meterStart)) / 1000
                : 0);
            const rate = tx.tariffRate && Number(tx.tariffRate) > 0 ? Number(tx.tariffRate) : 125;
            const cost = Number(tx.cost) > 0 ? Number(tx.cost) : Number((energy * rate).toFixed(2));

            // Calculate accurate duration & start/stop display timestamps
            // 1. Hardware clock delta (startTime -> stopTime) is always measured on the same charger clock
            const hwStartMs = tx.startTime ? new Date(tx.startTime).getTime() : NaN;
            const hwStopMs = tx.stopTime ? new Date(tx.stopTime).getTime() : NaN;
            const hwDiffMs = !isNaN(hwStartMs) && !isNaN(hwStopMs) && hwStopMs > hwStartMs ? hwStopMs - hwStartMs : 0;

            // 2. Server clock timestamps (createdAt -> lastTelemetryAt / updatedAt)
            const srvStartMs = tx.createdAt ? new Date(tx.createdAt).getTime() : NaN;
            const srvStopRaw = isCompleted ? (tx.lastTelemetryAt || tx.updatedAt) : null;
            const srvStopMs = srvStopRaw ? new Date(srvStopRaw).getTime() : NaN;
            const srvDiffMs = !isNaN(srvStartMs) && !isNaN(srvStopMs) && srvStopMs > srvStartMs ? srvStopMs - srvStartMs : 0;

            // Prefer hardware elapsed duration when available; otherwise use server elapsed duration
            const effectiveDiffMs = hwDiffMs > 0 ? hwDiffMs : srvDiffMs;

            let stopDate: Date | null = !isNaN(srvStopMs)
              ? new Date(srvStopMs)
              : (!isNaN(hwStopMs) ? new Date(hwStopMs) : null);

            let startDate: Date | null = !isNaN(srvStartMs)
              ? new Date(srvStartMs)
              : (!isNaN(hwStartMs) ? new Date(hwStartMs) : null);

            // If createdAt was missing or overwritten by updatedAt in cache (srvDiffMs < 60s while hwDiffMs >= 60s),
            // reconstruct startDate from stopDate minus hardware duration so display times are accurate in PKT
            if (stopDate && hwDiffMs >= 60000 && (isNaN(srvStartMs) || srvDiffMs < 60000)) {
              startDate = new Date(stopDate.getTime() - hwDiffMs);
            } else if (startDate && hwDiffMs >= 60000 && isCompleted && (!stopDate || srvDiffMs > hwDiffMs + 600000)) {
              // If updatedAt was touched much later by a batch script, anchor stopDate to startDate + hwDiffMs
              stopDate = new Date(startDate.getTime() + hwDiffMs);
            }

            const timeLabel = startDate
              ? startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : '';
            const stopLabel = isCompleted && stopDate
              ? stopDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : '';

            let durationText = '';
            if (isCompleted && effectiveDiffMs > 0) {
              const mins = Math.max(1, Math.round(effectiveDiffMs / 60000));
              durationText = `${mins} min`;
            } else if (!isCompleted && startDate) {
              const liveDiffMs = Math.max(0, Date.now() - startDate.getTime());
              const mins = Math.max(1, Math.round(liveDiffMs / 60000));
              durationText = `${mins} min`;
            }

            const gunLabel = tx.connectorId === 2 ? 'Gun B' : 'Gun A';

            return (
              <View key={tx.id || tx.transactionId} style={styles.txCard}>
                <View style={styles.txHeader}>
                  <View style={styles.txHeaderLeft}>
                    <View style={styles.gunBadge}>
                      <Text style={styles.gunBadgeText}>{gunLabel}</Text>
                    </View>
                    <Text style={styles.txId}>#{tx.transactionId || tx.id}</Text>
                  </View>

                  <View
                    style={[
                      styles.statusPill,
                      isCompleted ? styles.statusPillCompleted : styles.statusPillCharging,
                    ]}
                  >
                    <View
                      style={[
                        styles.statusPillDot,
                        isCompleted
                          ? { backgroundColor: '#10B981' }
                          : { backgroundColor: '#0284C7' },
                      ]}
                    />
                    <Text
                      style={[
                        styles.statusPillText,
                        isCompleted ? styles.statusTextCompleted : styles.statusTextCharging,
                      ]}
                    >
                      {isCompleted ? 'COMPLETED' : 'IN PROGRESS'}
                    </Text>
                  </View>
                </View>

                {/* Energy, Cost, Battery & Time Row */}
                <View style={styles.txBody}>
                  <View style={{ flex: 1, paddingRight: 10 }}>
                    {/* Primary Row: Price & Energy */}
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ fontSize: 18, fontWeight: '900', color: '#0F172A' }}>
                        PKR {cost.toFixed(2)}
                      </Text>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: '#0284C7' }}>
                        {energy.toFixed(2)} kWh
                      </Text>
                    </View>

                    {/* Battery Percentage Journey (Start -> End) */}
                    {(() => {
                      const startSoc = typeof tx.socStart === 'number' && tx.socStart > 0 ? tx.socStart : (typeof tx.soc_start === 'number' && tx.soc_start > 0 ? tx.soc_start : null);
                      const stopSoc = typeof tx.socStop === 'number' && tx.socStop > 0
                        ? tx.socStop
                        : (typeof tx.soc_stop === 'number' && tx.soc_stop > 0
                          ? tx.soc_stop
                          : typeof tx.socCurrent === 'number' && tx.socCurrent > 0
                          ? tx.socCurrent
                          : typeof tx.soc_current === 'number' && tx.soc_current > 0
                          ? tx.soc_current
                          : null);

                      if (startSoc && stopSoc) {
                        const gained = stopSoc >= startSoc ? Number((stopSoc - startSoc).toFixed(1)) : 0;
                        return (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 2 }}>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>
                              {startSoc}% → {stopSoc}%
                            </Text>
                            {gained > 0 && (
                              <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>
                                +{gained}%
                              </Text>
                            )}
                          </View>
                        );
                      }

                      if (startSoc) {
                        return (
                          <View style={{ marginVertical: 2 }}>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>
                              {startSoc}%
                            </Text>
                          </View>
                        );
                      }

                      if (stopSoc) {
                        return (
                          <View style={{ marginVertical: 2 }}>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>
                              {stopSoc}%
                            </Text>
                          </View>
                        );
                      }

                      return null;
                    })()}

                    <Text style={styles.txTimeSub}>
                      {timeLabel} {stopLabel ? `→ ${stopLabel}` : ''}{' '}
                      {durationText ? `(${durationText})` : ''}
                    </Text>
                  </View>

                  <View style={styles.txUserBadge}>
                    <Text style={styles.txUserLabel}>USER / AUTH</Text>
                    <Text style={styles.txUserVal} numberOfLines={1}>
                      {tx.userEmail ? tx.userEmail.split('@')[0] : (tx.idTag || 'AppUser')}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })
        )}
      </View>

      <View style={{ height: 60 }} />
    </ScrollView>
    </SwipeableTabScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 56 : 36,
    paddingBottom: 40,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  topHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  pageTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: 0.5,
  },
  collapseToggle: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  collapseToggleText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
  },

  /* Sync Bar */
  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 14,
  },
  syncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  syncBadgeIcon: {
    fontSize: 13,
  },
  syncBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
  },
  syncButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: '#E0F2FE',
    borderWidth: 1,
    borderColor: '#BAE6FD',
  },
  syncButtonText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0284C7',
  },

  /* Scope Selector */
  scopeSelector: {
    flexDirection: 'row',
    backgroundColor: '#F1F5F9',
    borderRadius: 12,
    padding: 3,
    marginBottom: 12,
  },
  scopeBtn: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 9,
  },
  scopeBtnActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },
  scopeBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748B',
  },
  scopeBtnTextActive: {
    color: '#0F172A',
  },

  /* Filter Tabs */
  filterTabsRow: {
    flexDirection: 'row',
    backgroundColor: '#F8FAFC',
    borderRadius: 14,
    padding: 3,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 16,
  },
  filterTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 11,
  },
  filterTabActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  filterTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
  },
  filterTabTextActive: {
    color: '#0F172A',
    fontWeight: '800',
  },

  /* Calendar Card */
  calendarCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 18,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 8,
    elevation: 2,
  },
  calendarNavHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  monthTitleText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: 0.5,
  },
  navArrowBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  navArrowText: {
    fontSize: 18,
    color: '#0F172A',
    fontWeight: '700',
    lineHeight: 20,
  },
  weekHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  weekDayLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '700',
    color: '#94A3B8',
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCellEmpty: {
    width: '14.28%',
    height: 52,
  },
  dayCell: {
    width: '14.28%',
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 2,
  },
  dayCellToday: {
    borderWidth: 1,
    borderColor: '#0284C7',
    backgroundColor: '#F0F9FF',
  },
  dayCellSelected: {
    backgroundColor: '#0F172A',
    borderColor: '#0F172A',
  },
  dayNumberText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1E293B',
  },
  dayNumberTextToday: {
    color: '#0284C7',
    fontWeight: '900',
  },
  dayNumberTextSelected: {
    color: '#FFFFFF',
    fontWeight: '900',
  },
  energyIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginTop: 2,
  },
  chargingDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#10B981',
  },
  dayEnergyLabel: {
    fontSize: 8,
    fontWeight: '800',
    color: '#059669',
  },

  /* Summary Bar */
  summaryBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#F1F5F9',
    marginBottom: 16,
  },
  summaryTextGroup: {
    flex: 1,
  },
  summaryFilterLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#94A3B8',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  summaryValuesRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  summaryEnergyVal: {
    fontSize: 28,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -1,
  },
  summaryEnergyUnit: {
    fontSize: 14,
    fontWeight: '800',
    color: '#64748B',
    marginLeft: 4,
  },
  summaryCount: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748B',
    marginLeft: 6,
  },
  quickTodayBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#F1F5F9',
  },
  quickTodayBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0284C7',
  },

  /* Sessions List */
  sessionList: {
    gap: 12,
  },
  emptyCard: {
    paddingVertical: 40,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  emptyIcon: {
    fontSize: 32,
    marginBottom: 10,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 4,
  },
  emptySub: {
    fontSize: 12,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 18,
  },
  txCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.02,
    shadowRadius: 4,
    elevation: 1,
  },
  txHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  txHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  gunBadge: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  gunBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#334155',
  },
  txId: {
    fontSize: 12,
    fontWeight: '800',
    color: '#64748B',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  statusPillCompleted: {
    backgroundColor: '#ECFDF5',
  },
  statusPillCharging: {
    backgroundColor: '#F0F9FF',
  },
  statusPillDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginRight: 5,
  },
  statusPillText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  statusTextCompleted: {
    color: '#065F46',
  },
  statusTextCharging: {
    color: '#0369A1',
  },
  txBody: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  txEnergyValue: {
    fontSize: 18,
    fontWeight: '900',
    color: '#0F172A',
  },
  txTimeSub: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
    fontWeight: '500',
  },
  txUserBadge: {
    alignItems: 'flex-end',
  },
  txUserLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 0.5,
  },
  txUserVal: {
    fontSize: 11,
    fontWeight: '800',
    color: '#475569',
    marginTop: 1,
  },
});
