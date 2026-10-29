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
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';
import { ref, onValue } from 'firebase/database';
import { db, rtdb, livePath } from '@/config/firebase';
import {
  fetchTransactionsWithCacheStrategy,
  getLocalTransactions,
  saveLocalTransactions,
} from '@/services/storage';
import { HistorySkeleton } from '@/components/skeleton';

type FilterMode = 'today' | 'day' | 'range' | 'month';

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Helper to format Date into YYYY-MM-DD
function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function HistoryScreen() {
  const { chargerId, user } = useAuth();
  const CHARGER_ID = chargerId || 'charger1';

  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dataSource, setDataSource] = useState<'local' | 'cloud'>('local');
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);

  // Account scope filter: 'all' (all station sessions) vs 'mine' (personal user sessions)
  // Default to 'all' so every device immediately sees all transactions on this charger
  const [accountScope, setAccountScope] = useState<'mine' | 'all'>('all');

  // Today key
  const todayKey = useMemo(() => formatDateKey(new Date()), []);

  // Filter state
  const [filterMode, setFilterMode] = useState<FilterMode>('today');
  const [selectedDate, setSelectedDate] = useState<string>(todayKey);
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [rangeEnd, setRangeEnd] = useState<string | null>(null);

  // Calendar month view
  const [viewDate, setViewDate] = useState<Date>(new Date());
  const [calendarCollapsed, setCalendarCollapsed] = useState<boolean>(false);

  // 1. Fetch transactions with local-first cache strategy (fallback & pull-to-refresh)
  const loadHistory = useCallback(
    async (forceRefresh: boolean = false) => {
      if (forceRefresh) {
        setRefreshing(true);
      }
      try {
        const res = await fetchTransactionsWithCacheStrategy(CHARGER_ID, forceRefresh, user?.uid);
        setTransactions(res.data);
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

  // 2. Real-time cross-device sync via Firestore onSnapshot & RTDB onValue
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

    // Real-time Firestore sync across all devices
    const q = query(
      collection(db, 'transactions'),
      orderBy('startTime', 'desc')
    );

    const unsubscribeFs = onSnapshot(
      q,
      (snapshot) => {
        if (!isMounted) return;
        const cloudDocs: any[] = [];
        snapshot.forEach((doc) => {
          cloudDocs.push({ id: doc.id, ...doc.data() });
        });

        // Filter for this charger and exclude dummy or 0 kWh sessions
        const filtered = cloudDocs.filter((tx) => {
          const id = String(tx.transactionId || tx.id || '').trim();
          if (id === '275384' || id === '72089') return false;
          if (tx.chargePointId && String(tx.chargePointId).toLowerCase() !== cleanId) return false;
          const kwh = Number(tx.energyDeliveredKwh) || (tx.energyDeliveredWh ? Number(tx.energyDeliveredWh) / 1000 : 0);
          return kwh > 0;
        });

        // Deduplicate twin records (e.g. in-progress vs completed duplicate, or cellular retry)
        const dedupMap = new Map<string, any>();
        for (const tx of filtered) {
          const txId = tx.transactionId ? String(tx.transactionId).trim() : null;
          const timeKey = tx.startTime ? tx.startTime.substring(0, 16) : String(tx.createdAt || '').substring(0, 16);
          const dedupKey = txId ? `id_${txId}` : `conn_${tx.connectorId || 1}_${timeKey}`;

          if (!dedupMap.has(dedupKey)) {
            dedupMap.set(dedupKey, tx);
          } else {
            const existing = dedupMap.get(dedupKey);
            // Always prefer Completed session over in-progress/charging session
            if (tx.status === 'Completed' || (existing.status !== 'Completed' && (Number(tx.cost) || 0) >= (Number(existing.cost) || 0))) {
              dedupMap.set(dedupKey, { ...existing, ...tx });
            }
          }
        }

        const sorted = Array.from(dedupMap.values()).sort((a, b) => {
          const timeA = new Date(a.startTime || a.createdAt || a.stopTime || 0).getTime();
          const timeB = new Date(b.startTime || b.createdAt || b.stopTime || 0).getTime();
          return timeB - timeA;
        });

        setTransactions(sorted);
        saveLocalTransactions(cleanId, sorted, user?.uid);

        setDataSource('cloud');
        setLastSyncTime(new Date().toISOString());
        setLoading(false);
        setRefreshing(false);
      },
      (err) => {
        console.warn('[History Realtime] Firestore onSnapshot note:', err.message);
        loadHistory(false);
      }
    );

    // Instant RTDB push sync for recently completed session
    let unsubscribeRtdb: (() => void) | undefined;
    try {
      const lastTxRef = ref(rtdb, livePath(cleanId, 'lastCompletedTx'));
      unsubscribeRtdb = onValue(lastTxRef, (snapshot) => {
        if (!isMounted) return;
        const completed = snapshot.val();
        if (completed && (completed.transactionId || completed.id)) {
          setTransactions((prev) => {
            const map = new Map<string, any>();
            for (const item of prev) {
              const key = String(item.transactionId || item.id || '').trim();
              if (key) map.set(key, item);
            }
            const compKey = String(completed.transactionId || completed.id || '').trim();
            const existing = map.get(compKey) || {};
            map.set(compKey, {
              ...existing,
              ...completed,
              id: compKey,
              transactionId: completed.transactionId || existing.transactionId || compKey,
            });
            const merged = Array.from(map.values()).sort((a, b) => {
              const timeA = new Date(a.startTime || a.createdAt || a.stopTime || 0).getTime();
              const timeB = new Date(b.startTime || b.createdAt || b.stopTime || 0).getTime();
              return timeB - timeA;
            });
            saveLocalTransactions(cleanId, merged, user?.uid);
            return merged;
          });
          setDataSource('cloud');
          setLastSyncTime(new Date().toISOString());
        }
      });
    } catch (_e) {}

    return () => {
      isMounted = false;
      unsubscribeFs();
      if (unsubscribeRtdb) unsubscribeRtdb();
    };
  }, [CHARGER_ID, user?.uid, loadHistory]);

  // Isolate transactions per user account and deduplicate by transactionId
  const scopedTransactions = useMemo(() => {
    const list = accountScope === 'all'
      ? transactions
      : transactions.filter((tx) => {
          if (tx.userId) return tx.userId === user?.uid;
          if (tx.userEmail) return tx.userEmail.toLowerCase() === (user?.email || '').toLowerCase();
          return true;
        });

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
        map.set(key, {
          ...existing,
          ...tx,
          status: isCompleted ? 'Completed' : (tx.status || existing.status),
          computedKwh: Math.max(kwh, existKwh),
          cost: Math.max(curCost, existCost),
          socStart: typeof tx.socStart === 'number' ? tx.socStart : existing.socStart,
          socStop: typeof tx.socStop === 'number' ? tx.socStop : existing.socStop,
          socGained: typeof tx.socGained === 'number' ? tx.socGained : existing.socGained,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const timeA = new Date(a.startTime || a.createdAt || a.stopTime || 0).getTime();
      const timeB = new Date(b.startTime || b.createdAt || b.stopTime || 0).getTime();
      return timeB - timeA;
    });
  }, [transactions, accountScope, user]);

  // 2. Map transactions to date keys (YYYY-MM-DD)
  const getTxDateKey = (tx: any): string => {
    const ts = tx.startTime || tx.createdAt || tx.stopTime;
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
    const d = new Date(year, month, dayNum);
    const dateStr = formatDateKey(d);

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
      setFilterMode('day');
      setSelectedDate(dateStr);
    }
  };

  // 5. Filter Transactions Based on Active Filter
  const filteredTransactions = useMemo(() => {
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
    if (filterMode === 'today') return 'Today';
    if (filterMode === 'day') {
      const d = new Date(selectedDate + 'T00:00:00');
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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
  }, [filterMode, selectedDate, rangeStart, rangeEnd, monthName]);

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
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
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
        <TouchableOpacity
          style={styles.collapseToggle}
          onPress={() => setCalendarCollapsed((prev) => !prev)}
        >
          <Text style={styles.collapseToggleText}>
            {calendarCollapsed ? '📅 Show Calendar' : '📅 Hide Calendar'}
          </Text>
        </TouchableOpacity>
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

      {/* Account Scope Switcher: All Station Activity vs My Sessions */}
      <View style={styles.scopeSelector}>
        <TouchableOpacity
          style={[styles.scopeBtn, accountScope === 'all' && styles.scopeBtnActive]}
          onPress={() => setAccountScope('all')}
          activeOpacity={0.7}
        >
          <Text style={[styles.scopeBtnText, accountScope === 'all' && styles.scopeBtnTextActive]}>
            ⚡ All Station Activity
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.scopeBtn, accountScope === 'mine' && styles.scopeBtnActive]}
          onPress={() => setAccountScope('mine')}
          activeOpacity={0.7}
        >
          <Text style={[styles.scopeBtnText, accountScope === 'mine' && styles.scopeBtnTextActive]}>
            👤 My Sessions
          </Text>
        </TouchableOpacity>
      </View>

      {/* Filter Mode Tabs */}
      <View style={styles.filterTabsRow}>
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
              const dateStr = formatDateKey(new Date(year, month, dayNum));
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

            const startDate = tx.startTime ? new Date(tx.startTime) : null;
            const stopDate = tx.stopTime ? new Date(tx.stopTime) : null;

            const timeLabel = startDate
              ? startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : '';
            const stopLabel = stopDate
              ? stopDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : '';

            // Calculate duration
            let durationText = '';
            if (startDate && stopDate) {
              const diffMs = stopDate.getTime() - startDate.getTime();
              const mins = Math.max(1, Math.round(diffMs / 60000));
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
                      const startSoc = typeof tx.socStart === 'number' && tx.socStart > 0 ? tx.socStart : null;
                      const stopSoc = typeof tx.socStop === 'number' && tx.socStop > 0
                        ? tx.socStop
                        : typeof tx.socCurrent === 'number' && tx.socCurrent > 0
                        ? tx.socCurrent
                        : null;

                      if (startSoc && stopSoc) {
                        const gained = stopSoc >= startSoc ? stopSoc - startSoc : 0;
                        return (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 3 }}>
                            <View style={{ backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                              <Text style={{ fontSize: 11, fontWeight: '700', color: '#0F172A' }}>
                                SOC {startSoc}% → {stopSoc}%{gained > 0 ? ` (+${gained}%)` : ''}
                              </Text>
                            </View>
                          </View>
                        );
                      }

                      if (stopSoc) {
                        return (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 3 }}>
                            <View style={{ backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                              <Text style={{ fontSize: 11, fontWeight: '700', color: '#0F172A' }}>
                                SOC Final: {stopSoc}%
                              </Text>
                            </View>
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
