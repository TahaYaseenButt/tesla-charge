import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useAuth } from '@/config/auth';
import {
  fetchTransactionsWithCacheStrategy,
  getLocalTransactions,
  saveLocalTransactions,
} from '@/services/storage';

type TimeFilter = 'today' | 'week' | 'month' | 'year' | 'all';

interface DaySummary {
  dateStr: string; // YYYY-MM-DD
  dayLabel: string; // e.g. "Thu, Oct 29"
  revenue: number;
  kwh: number;
  sessions: number;
  gunARevenue: number;
  gunBRevenue: number;
}

interface MonthSummary {
  monthKey: string; // YYYY-MM
  monthLabel: string; // e.g. "October 2026"
  revenue: number;
  kwh: number;
  sessions: number;
  days: DaySummary[];
}

export default function RevenueScreen() {
  const { chargerId: configuredId, user } = useAuth();
  const CHARGER_ID = (configuredId || user?.stationId || user?.defaultChargerId || 'charger1').trim().toLowerCase();
  const cleanId = CHARGER_ID;

  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);

  // Time filter state
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('month');

  // Month navigation state (for 'month' filter)
  const today = new Date();
  const [selectedYear, setSelectedYear] = useState<number>(today.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number>(today.getMonth()); // 0-indexed

  // Expanded months set in Year view
  const [expandedMonths, setExpandedMonths] = useState<Record<string, boolean>>({});

  // 1. Fetch transactions with cache strategy
  const loadRevenueData = useCallback(
    async (forceRefresh: boolean = false) => {
      if (forceRefresh) setRefreshing(true);
      try {
        const res = await fetchTransactionsWithCacheStrategy(CHARGER_ID, forceRefresh, user?.uid);
        setTransactions(res.data);
        setLastSyncTime(res.lastSyncedAt || null);
      } catch (err) {
        console.warn('[Revenue] Load error:', err);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [CHARGER_ID, user?.uid]
  );

  // 2. Direct Server Periodic Sync & Initial Cache Load
  useEffect(() => {
    let isMounted = true;

    // Fast 0ms cache load
    getLocalTransactions(cleanId, user?.uid).then((cached) => {
      if (isMounted && cached && cached.length > 0) {
        setTransactions(cached);
        setLoading(false);
      }
    });

    // Immediate direct server fetch
    loadRevenueData(false);

    // Periodic direct server poll (every 10s)
    const interval = setInterval(() => {
      if (isMounted) {
        loadRevenueData(false);
      }
    }, 10000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [cleanId, user?.uid, loadRevenueData]);

  // Normalized transaction metrics helper
  const parsedTransactions = useMemo(() => {
    return transactions.map((tx) => {
      const energyKwh =
        Number(tx.energyDeliveredKwh) ||
        (Number(tx.energyDeliveredWh) ? Number(tx.energyDeliveredWh) / 1000 : 0) ||
        (tx.meterStop && tx.meterStart && Number(tx.meterStop) > Number(tx.meterStart)
          ? (Number(tx.meterStop) - Number(tx.meterStart)) / 1000
          : 0);
      const rate = Number(tx.tariffRate) > 0 ? Number(tx.tariffRate) : 125;
      const cost = Number(tx.cost) > 0 ? Number(tx.cost) : Math.round(energyKwh * rate);
      const connId = Number(tx.connectorId) || 1;

      const rawDateStr = tx.startTime || tx.createdAt || tx.stopTime;
      const dateObj = rawDateStr ? new Date(rawDateStr) : new Date();
      const validDate = isNaN(dateObj.getTime()) ? new Date() : dateObj;

      const y = validDate.getFullYear();
      const m = String(validDate.getMonth() + 1).padStart(2, '0');
      const d = String(validDate.getDate()).padStart(2, '0');
      const dateKey = `${y}-${m}-${d}`;
      const monthKey = `${y}-${m}`;

      return {
        ...tx,
        energyKwh,
        cost,
        rate,
        connId,
        dateObj: validDate,
        dateKey,
        monthKey,
      };
    });
  }, [transactions]);

  // Lifetime Overall Totals
  const lifetimeTotals = useMemo(() => {
    let rev = 0;
    let kwh = 0;
    let gunARev = 0;
    let gunBRev = 0;

    for (const tx of parsedTransactions) {
      rev += tx.cost;
      kwh += tx.energyKwh;
      if (tx.connId === 2) {
        gunBRev += tx.cost;
      } else {
        gunARev += tx.cost;
      }
    }

    const count = parsedTransactions.length;
    const avgPerSession = count > 0 ? Math.round(rev / count) : 0;
    const avgPerKwh = kwh > 0 ? Number((rev / kwh).toFixed(1)) : 125;

    return {
      revenue: Math.round(rev),
      kwh: Number(kwh.toFixed(2)),
      count,
      gunARevenue: Math.round(gunARev),
      gunBRevenue: Math.round(gunBRev),
      avgPerSession,
      avgPerKwh,
    };
  }, [parsedTransactions]);

  // Selected Month helper string
  const selectedMonthKey = `${selectedYear}-${String(selectedMonth + 1).padStart(2, '0')}`;
  const selectedMonthLabel = useMemo(() => {
    const d = new Date(selectedYear, selectedMonth, 1);
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }, [selectedYear, selectedMonth]);

  // Today helper string
  const todayKey = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }, []);

  // Filtered Transactions according to active TimeFilter
  const filteredList = useMemo(() => {
    const now = new Date();

    if (timeFilter === 'today') {
      return parsedTransactions.filter((tx) => tx.dateKey === todayKey);
    }

    if (timeFilter === 'week') {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return parsedTransactions.filter((tx) => tx.dateObj >= sevenDaysAgo);
    }

    if (timeFilter === 'month') {
      return parsedTransactions.filter((tx) => tx.monthKey === selectedMonthKey);
    }

    if (timeFilter === 'year') {
      return parsedTransactions.filter((tx) => tx.dateObj.getFullYear() === selectedYear);
    }

    return parsedTransactions; // 'all'
  }, [parsedTransactions, timeFilter, todayKey, selectedMonthKey, selectedYear]);

  // Aggregate Period Summary Stats
  const periodTotals = useMemo(() => {
    let rev = 0;
    let kwh = 0;
    let gunARev = 0;
    let gunBRev = 0;

    for (const tx of filteredList) {
      rev += tx.cost;
      kwh += tx.energyKwh;
      if (tx.connId === 2) {
        gunBRev += tx.cost;
      } else {
        gunARev += tx.cost;
      }
    }

    const count = filteredList.length;
    const avgPerSession = count > 0 ? Math.round(rev / count) : 0;

    return {
      revenue: Math.round(rev),
      kwh: Number(kwh.toFixed(2)),
      count,
      gunARevenue: Math.round(gunARev),
      gunBRevenue: Math.round(gunBRev),
      avgPerSession,
    };
  }, [filteredList]);

  // Aggregate Daily Breakdown for the filtered list
  const dailyBreakdown = useMemo(() => {
    const map = new Map<string, DaySummary>();

    for (const tx of filteredList) {
      const key = tx.dateKey;
      if (!map.has(key)) {
        const dObj = tx.dateObj;
        const dayLabel = dObj.toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        });
        map.set(key, {
          dateStr: key,
          dayLabel,
          revenue: tx.cost,
          kwh: tx.energyKwh,
          sessions: 1,
          gunARevenue: tx.connId === 2 ? 0 : tx.cost,
          gunBRevenue: tx.connId === 2 ? tx.cost : 0,
        });
      } else {
        const item = map.get(key)!;
        item.revenue += tx.cost;
        item.kwh += tx.energyKwh;
        item.sessions += 1;
        if (tx.connId === 2) {
          item.gunBRevenue += tx.cost;
        } else {
          item.gunARevenue += tx.cost;
        }
      }
    }

    // Sort descending by date
    const arr = Array.from(map.values()).sort((a, b) => (b.dateStr > a.dateStr ? 1 : -1));
    return arr;
  }, [filteredList]);

  // Peak day revenue for visual bar scaling
  const maxDailyRevenue = useMemo(() => {
    let max = 1;
    for (const d of dailyBreakdown) {
      if (d.revenue > max) max = d.revenue;
    }
    return max;
  }, [dailyBreakdown]);

  // Aggregate Monthly Breakdown (used for Year / All Time views)
  const monthlyBreakdown = useMemo(() => {
    const map = new Map<string, MonthSummary>();

    for (const tx of filteredList) {
      const mKey = tx.monthKey;
      if (!map.has(mKey)) {
        const mObj = new Date(tx.dateObj.getFullYear(), tx.dateObj.getMonth(), 1);
        const monthLabel = mObj.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        map.set(mKey, {
          monthKey: mKey,
          monthLabel,
          revenue: tx.cost,
          kwh: tx.energyKwh,
          sessions: 1,
          days: [],
        });
      } else {
        const item = map.get(mKey)!;
        item.revenue += tx.cost;
        item.kwh += tx.energyKwh;
        item.sessions += 1;
      }
    }

    return Array.from(map.values()).sort((a, b) => (b.monthKey > a.monthKey ? 1 : -1));
  }, [filteredList]);

  // Month navigation handlers
  const prevMonth = () => {
    if (selectedMonth === 0) {
      setSelectedYear((y) => y - 1);
      setSelectedMonth(11);
    } else {
      setSelectedMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (selectedMonth === 11) {
      setSelectedYear((y) => y + 1);
      setSelectedMonth(0);
    } else {
      setSelectedMonth((m) => m + 1);
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => loadRevenueData(true)}
          tintColor="#0F172A"
          colors={['#0F172A']}
        />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.screenTitle}>{CHARGER_ID.toUpperCase()}</Text>
        <Text style={styles.screenLabel}>Revenue</Text>
      </View>

      {/* Main Revenue Card */}
      <View style={styles.heroCard}>
        <Text style={styles.heroLabel}>Total Revenue</Text>
        <Text style={styles.heroRevenueValue}>
          PKR {lifetimeTotals.revenue.toLocaleString()}
        </Text>

        <View style={styles.heroMetaRow}>
          <Text style={styles.heroMetaItem}>{lifetimeTotals.kwh.toLocaleString()} kWh</Text>
          <Text style={styles.heroMetaDot}>•</Text>
          <Text style={styles.heroMetaItem}>{lifetimeTotals.count} sessions</Text>
          <Text style={styles.heroMetaDot}>•</Text>
          <Text style={styles.heroMetaItem}>PKR {lifetimeTotals.avgPerKwh}/kWh</Text>
        </View>
      </View>

      {/* Dual Connector Breakdown */}
      <View style={styles.gunSplitRow}>
        <View style={styles.gunSplitCard}>
          <Text style={styles.gunSplitTitle}>GUN 1</Text>
          <Text style={styles.gunSplitAmount}>PKR {lifetimeTotals.gunARevenue.toLocaleString()}</Text>
          <Text style={styles.gunSplitPercent}>
            {lifetimeTotals.revenue > 0
              ? `${Math.round((lifetimeTotals.gunARevenue / lifetimeTotals.revenue) * 100)}%`
              : '0%'}
          </Text>
        </View>

        <View style={styles.gunSplitCard}>
          <Text style={styles.gunSplitTitle}>GUN 2</Text>
          <Text style={styles.gunSplitAmount}>PKR {lifetimeTotals.gunBRevenue.toLocaleString()}</Text>
          <Text style={styles.gunSplitPercent}>
            {lifetimeTotals.revenue > 0
              ? `${Math.round((lifetimeTotals.gunBRevenue / lifetimeTotals.revenue) * 100)}%`
              : '0%'}
          </Text>
        </View>
      </View>

      {/* Time Period Filter Tabs */}
      <View style={styles.filterPillsRow}>
        {(['today', 'week', 'month', 'year', 'all'] as TimeFilter[]).map((tab) => {
          const isActive = timeFilter === tab;
          const labels: Record<TimeFilter, string> = {
            today: 'Today',
            week: '7D',
            month: 'Month',
            year: 'Year',
            all: 'All',
          };
          return (
            <TouchableOpacity
              key={tab}
              style={[styles.filterPill, isActive && styles.filterPillActive]}
              onPress={() => setTimeFilter(tab)}
            >
              <Text style={[styles.filterPillText, isActive && styles.filterPillTextActive]}>
                {labels[tab]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Month Navigator */}
      {timeFilter === 'month' && (
        <View style={styles.monthNavigator}>
          <TouchableOpacity onPress={prevMonth} style={styles.navArrowBtn}>
            <Text style={styles.navArrowText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.monthNavTitle}>{selectedMonthLabel}</Text>
          <TouchableOpacity onPress={nextMonth} style={styles.navArrowBtn}>
            <Text style={styles.navArrowText}>›</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Period Summary */}
      <View style={styles.periodKpiCard}>
        <View style={styles.periodKpiItem}>
          <Text style={styles.periodKpiLabel}>Revenue</Text>
          <Text style={styles.periodKpiVal}>PKR {periodTotals.revenue.toLocaleString()}</Text>
        </View>
        <View style={styles.periodKpiDivider} />
        <View style={styles.periodKpiItem}>
          <Text style={styles.periodKpiLabel}>Energy</Text>
          <Text style={styles.periodKpiVal}>{periodTotals.kwh} kWh</Text>
        </View>
        <View style={styles.periodKpiDivider} />
        <View style={styles.periodKpiItem}>
          <Text style={styles.periodKpiLabel}>Sessions</Text>
          <Text style={styles.periodKpiVal}>{periodTotals.count}</Text>
        </View>
      </View>

      {/* Loading state indicator */}
      {loading && !refreshing && (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="small" color="#0F172A" />
          <Text style={styles.loadingText}>Updating...</Text>
        </View>
      )}

      {/* Section Title */}
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>
          {timeFilter === 'year' || timeFilter === 'all' ? 'Monthly Overview' : 'Breakdown'}
        </Text>
      </View>

      {/* If Year or All Time: Display Monthly Overview */}
      {(timeFilter === 'year' || timeFilter === 'all') && (
        <View style={styles.monthlyList}>
          {monthlyBreakdown.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptySub}>No sessions recorded</Text>
            </View>
          ) : (
            monthlyBreakdown.map((m) => (
              <View key={m.monthKey} style={styles.monthCard}>
                <View style={styles.monthCardHeader}>
                  <View>
                    <Text style={styles.monthCardTitle}>{m.monthLabel}</Text>
                    <Text style={styles.monthCardMeta}>
                      {m.sessions} {m.sessions === 1 ? 'session' : 'sessions'} • {m.kwh.toFixed(1)} kWh
                    </Text>
                  </View>
                  <Text style={styles.monthCardRev}>PKR {m.revenue.toLocaleString()}</Text>
                </View>
              </View>
            ))
          )}
        </View>
      )}

      {/* Daily Breakdown List */}
      {timeFilter !== 'year' && timeFilter !== 'all' && (
        <View style={styles.dailyList}>
          {dailyBreakdown.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptySub}>No sessions recorded</Text>
            </View>
          ) : (
            dailyBreakdown.map((day) => {
              const isToday = day.dateStr === todayKey;

              return (
                <View key={day.dateStr} style={[styles.dayCard, isToday && styles.dayCardToday]}>
                  <View style={styles.dayTopRow}>
                    <Text style={styles.dayDateText}>
                      {day.dayLabel} {isToday ? '(Today)' : ''}
                    </Text>
                    <Text style={styles.dayRevText}>PKR {day.revenue.toLocaleString()}</Text>
                  </View>
                  <View style={styles.dayMetaRow}>
                    <Text style={styles.dayMetaText}>
                      {day.sessions} {day.sessions === 1 ? 'session' : 'sessions'} • {day.kwh.toFixed(1)} kWh
                    </Text>
                    <Text style={styles.dayMetaText}>
                      Gun 1: {day.gunARevenue.toLocaleString()} • Gun 2: {day.gunBRevenue.toLocaleString()}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
        </View>
      )}

      {/* Sync Footer */}
      {lastSyncTime && (
        <View style={styles.syncFooter}>
          <Text style={styles.syncFooterText}>
            Updated {new Date(lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      )}
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
  header: {
    marginBottom: 20,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -0.5,
  },
  screenLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 2,
  },

  /* Total Revenue Card */
  heroCard: {
    backgroundColor: '#0F172A',
    borderRadius: 16,
    padding: 20,
    marginBottom: 12,
  },
  heroLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94A3B8',
  },
  heroRevenueValue: {
    fontSize: 34,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: -0.5,
    marginVertical: 4,
  },
  heroMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  heroMetaItem: {
    fontSize: 12,
    fontWeight: '600',
    color: '#CBD5E1',
  },
  heroMetaDot: {
    fontSize: 12,
    color: '#64748B',
  },

  /* Gun Split Cards */
  gunSplitRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  gunSplitCard: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  gunSplitTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 0.5,
  },
  gunSplitAmount: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
    marginTop: 4,
  },
  gunSplitPercent: {
    fontSize: 11,
    fontWeight: '500',
    color: '#94A3B8',
    marginTop: 2,
  },

  /* Filter Pills */
  filterPillsRow: {
    flexDirection: 'row',
    backgroundColor: '#F1F5F9',
    borderRadius: 10,
    padding: 3,
    marginBottom: 14,
  },
  filterPill: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 8,
  },
  filterPillActive: {
    backgroundColor: '#0F172A',
  },
  filterPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
  },
  filterPillTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },

  /* Month Navigator */
  monthNavigator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 12,
  },
  navArrowBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: '#E2E8F0',
  },
  navArrowText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
    lineHeight: 18,
  },
  monthNavTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
  },

  /* Period Summary */
  periodKpiCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 16,
  },
  periodKpiItem: {
    flex: 1,
    alignItems: 'center',
  },
  periodKpiLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748B',
    marginBottom: 2,
  },
  periodKpiVal: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0F172A',
  },
  periodKpiDivider: {
    width: 1,
    height: 20,
    backgroundColor: '#E2E8F0',
  },

  /* Section Title */
  sectionHeaderRow: {
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  /* Daily List Cards */
  dailyList: {
    gap: 8,
  },
  dayCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  dayCardToday: {
    borderColor: '#0F172A',
  },
  dayTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  dayDateText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
  },
  dayRevText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A',
  },
  dayMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dayMetaText: {
    fontSize: 11,
    fontWeight: '500',
    color: '#64748B',
  },

  /* Monthly Overview List */
  monthlyList: {
    gap: 8,
  },
  monthCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  monthCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  monthCardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
  },
  monthCardMeta: {
    fontSize: 11,
    fontWeight: '500',
    color: '#64748B',
    marginTop: 2,
  },
  monthCardRev: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A',
  },

  /* Empty & Loading states */
  emptyCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  emptySub: {
    fontSize: 12,
    fontWeight: '500',
    color: '#64748B',
    textAlign: 'center',
  },
  loadingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  loadingText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#64748B',
  },
  syncFooter: {
    alignItems: 'center',
    marginTop: 20,
  },
  syncFooterText: {
    fontSize: 10,
    fontWeight: '500',
    color: '#94A3B8',
  },
});
