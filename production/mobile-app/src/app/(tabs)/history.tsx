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

export interface AbnormalityItem {
  code: string;
  severity: 'error' | 'warning' | 'info';
  badge: string;
  title: string;
  reason: string;
}

export interface SessionDiagnostics {
  isAbnormal: boolean;
  highestSeverity: 'normal' | 'info' | 'warning' | 'error';
  badges: { text: string; severity: 'error' | 'warning' | 'info' }[];
  items: AbnormalityItem[];
  recoveredStartSoc: number | null;
  recoveredStopSoc: number | null;
  recoveredFromTxId: string | null;
  siblingIds: string[];
  clockOffsetHours: number | null;
}

function getStopReasonDescription(reason?: string | null, isCompleted?: boolean): { label: string; desc: string; isAbnormalStop: boolean } {
  if (!isCompleted) {
    return { label: 'In Progress', desc: 'Vehicle is currently charging', isAbnormalStop: false };
  }
  const r = String(reason || 'Local').trim();
  switch (r) {
    case 'Local':
      return { label: 'Local Stop', desc: 'Stopped normally by user/RFID or vehicle at the charger', isAbnormalStop: false };
    case 'Remote':
      return { label: 'Remote Stop', desc: 'Stopped normally via Mobile App or O&M Control Center', isAbnormalStop: false };
    case 'EVDisconnected':
      return { label: 'EV Disconnected', desc: 'Charging ended when the charging gun was unplugged from the vehicle', isAbnormalStop: false };
    case 'Other':
      return { label: 'Vehicle BMS Full / Other', desc: 'Stopped automatically by the vehicle BMS (target SoC reached) or charger controller', isAbnormalStop: false };
    case 'PowerLoss':
      return { label: 'PowerLoss Recovery', desc: 'No normal StopTransaction received; auto-recovered by server watchdog using last meter reading', isAbnormalStop: true };
    case 'EmergencyStop':
      return { label: 'Emergency Stop', desc: 'Physical emergency stop button was pressed on the charger', isAbnormalStop: true };
    case 'Reboot':
      return { label: 'Charger Reboot', desc: 'Session interrupted by a charger firmware reboot', isAbnormalStop: true };
    case 'DeAuthorized':
      return { label: 'De-Authorized', desc: 'Session stopped because authorization was revoked', isAbnormalStop: true };
    default:
      return { label: r, desc: `Session ended with OCPP reason: ${r}`, isAbnormalStop: false };
  }
}

function analyzeSessionAbnormalities(tx: any, allTransactions: any[], energyKwh: number): SessionDiagnostics {
  const txIdStr = String(tx.transactionId || tx.id || '').trim();
  const connId = Number(tx.connectorId) || 1;
  const meterStart = typeof tx.meterStart === 'number' ? tx.meterStart : Number(tx.meterStart) || 0;
  const meterStop = typeof tx.meterStop === 'number' ? tx.meterStop : Number(tx.meterStop) || 0;
  const isCompleted = tx.status === 'Completed' || Boolean(tx.stopTime);
  const reason = String(tx.reason || '').trim();

  const rawStartSoc = typeof tx.socStart === 'number' ? tx.socStart : (typeof tx.soc_start === 'number' ? tx.soc_start : null);
  const rawStopSoc =
    typeof tx.socStop === 'number'
      ? tx.socStop
      : typeof tx.soc_stop === 'number'
      ? tx.soc_stop
      : typeof tx.socCurrent === 'number'
      ? tx.socCurrent
      : typeof tx.soc_current === 'number'
      ? tx.soc_current
      : null;

  const items: AbnormalityItem[] = [];
  const badges: { text: string; severity: 'error' | 'warning' | 'info' }[] = [];

  // 1. Find sibling duplicate / retry transactions (same connector + same meterStart or same startTime)
  const siblings = allTransactions.filter((other) => {
    const otherId = String(other.transactionId || other.id || '').trim();
    if (!otherId || otherId === txIdStr) return false;
    const otherConn = Number(other.connectorId) || 1;
    if (otherConn !== connId) return false;
    const otherMeterStart = Number(other.meterStart) || 0;
    if (meterStart > 0 && otherMeterStart > 0 && Math.abs(meterStart - otherMeterStart) <= 5) {
      return true;
    }
    if (tx.startTime && other.startTime && tx.startTime === other.startTime) {
      return true;
    }
    return false;
  });

  const siblingIds = siblings.map((s) => `#${s.transactionId || s.id}`);
  let recoveredStartSoc: number | null = null;
  let recoveredStopSoc: number | null = null;
  let recoveredFromTxId: string | null = null;

  // Check if any sibling has valid SoC that this transaction missed
  if ((rawStartSoc === null || rawStartSoc === 0) && (rawStopSoc === null || rawStopSoc === 0) && siblings.length > 0) {
    for (const sib of siblings) {
      const sStart = typeof sib.socStart === 'number' && sib.socStart > 0 ? sib.socStart : null;
      const sStop = typeof sib.socStop === 'number' && sib.socStop > 0 ? sib.socStop : null;
      if (sStart !== null || sStop !== null) {
        recoveredStartSoc = sStart;
        recoveredStopSoc = sStop;
        recoveredFromTxId = `#${sib.transactionId || sib.id}`;
        break;
      }
    }
  }

  // 2. Check for Duplicate Retry / Multi-Session Meter Span
  if (siblings.length > 0) {
    // Find minimum valid positive energy among the group
    const allInGroup = [tx, ...siblings];
    const energies = allInGroup
      .map((item) => {
        const ms = Number(item.meterStart) || 0;
        const me = Number(item.meterStop) || 0;
        return me > ms ? (me - ms) / 1000 : Number(item.energyDeliveredKwh) || 0;
      })
      .filter((e) => e > 0.1);
    const minGroupEnergy = energies.length > 0 ? Math.min(...energies) : energyKwh;

    if (energyKwh > minGroupEnergy + 1.0 && reason === 'PowerLoss') {
      // Example: #49540 (26.25 kWh) vs #49538/#49541 (13.70 kWh) + #49543 (12.54 kWh)
      const extraKwh = (energyKwh - minGroupEnergy).toFixed(2);
      badges.push({ text: '⚠️ Double-Counted Duplicate', severity: 'error' });
      items.push({
        code: 'DUPLICATE_COMBINED_METER',
        severity: 'error',
        badge: 'Double-Counted Retry',
        title: `Duplicate Retry Spanned Multiple Sessions (${energyKwh.toFixed(2)} kWh vs ${minGroupEnergy.toFixed(2)} kWh)`,
        reason: `This transaction shares the exact same starting meter (${meterStart.toLocaleString()} Wh) as ${siblingIds.join(', ')}. Because the charger re-sent StartTransaction during a slow network response, this duplicate ID stayed open in the background across the next charging session (+${extraKwh} kWh) until the PowerLoss watchdog closed it at ${meterStop.toLocaleString()} Wh. Actual single-session energy was ${minGroupEnergy.toFixed(2)} kWh.`,
      });
    } else if (reason === 'PowerLoss') {
      badges.push({ text: '⚠️ Duplicate Retry (PowerLoss)', severity: 'warning' });
      items.push({
        code: 'DUPLICATE_POWERLOSS',
        severity: 'warning',
        badge: 'Duplicate Retry',
        title: `Duplicate StartTransaction Retry (Sibling of ${siblingIds.join(', ')})`,
        reason: `The charger transmitted multiple StartTransaction requests with the same starting meter (${meterStart.toLocaleString()} Wh) because it did not receive the server's confirmation within 5 seconds. The normal StopTransaction was matched to sibling ${siblingIds.join(', ')}, while this duplicate record was automatically closed by the server's PowerLoss watchdog.`,
      });
    } else {
      badges.push({ text: 'ℹ️ Split Session Record', severity: 'info' });
      items.push({
        code: 'SPLIT_SESSION_PRIMARY',
        severity: 'info',
        badge: 'Split Record',
        title: `Primary Session with Duplicate Retries (${siblingIds.join(', ')})`,
        reason: `This is the primary completed session (${meterStart.toLocaleString()} → ${meterStop.toLocaleString()} Wh = ${energyKwh.toFixed(2)} kWh), but the charger also created duplicate retry record(s) ${siblingIds.join(', ')} at startup due to network retry timing.${recoveredFromTxId ? ` Live Battery SoC (${recoveredStartSoc}% → ${recoveredStopSoc}%) was recorded under sibling ${recoveredFromTxId}.` : ''}`,
      });
    }
  } else if (reason === 'PowerLoss') {
    // Standalone PowerLoss session
    badges.push({ text: '⚡ PowerLoss Recovery', severity: 'warning' });
    items.push({
      code: 'STANDALONE_POWERLOSS',
      severity: 'warning',
      badge: 'PowerLoss Watchdog',
      title: 'Abnormal Stop: Power Loss or Connection Drop',
      reason: `The charger did not send a normal OCPP StopTransaction packet (caused by an AC power outage, charger reboot, or >3 minute internet disconnect). The server automatically recovered and finalized the energy delivered (${energyKwh.toFixed(2)} kWh) from the hardware meter register.`,
    });
  } else if (reason === 'EmergencyStop') {
    badges.push({ text: '🚨 Emergency Stop', severity: 'error' });
    items.push({
      code: 'EMERGENCY_STOP',
      severity: 'error',
      badge: 'Emergency Stop',
      title: 'Stopped by Physical Emergency Stop Button',
      reason: 'The session was immediately terminated because the red Emergency Stop button on the charger cabinet was pressed.',
    });
  }

  // 3. Check Battery SoC Abnormalities
  if (isCompleted && energyKwh >= 0.5) {
    if (rawStartSoc === null && rawStopSoc === null) {
      if (recoveredFromTxId) {
        badges.push({ text: `🔋 SoC on ${recoveredFromTxId}`, severity: 'info' });
        items.push({
          code: 'SOC_ON_SIBLING',
          severity: 'info',
          badge: 'SoC Split',
          title: `Battery SoC Recorded on Sibling ${recoveredFromTxId} (${recoveredStartSoc}% → ${recoveredStopSoc}%)`,
          reason: `During this session, the charger streamed live MeterValues (Battery SoC ${recoveredStartSoc}% → ${recoveredStopSoc}%) under transaction ${recoveredFromTxId}, while sending the final StopTransaction under #${txIdStr}.`,
        });
      } else {
        badges.push({ text: '🔋 No BMS SoC', severity: 'info' });
        items.push({
          code: 'SOC_MISSING',
          severity: 'info',
          badge: 'Missing SoC',
          title: 'Battery SoC Not Reported (None → None)',
          reason: 'Although the hardware energy meter recorded power delivery, no State of Charge (SoC %) was received. This happens when using an AC/DC adapter that blocks CAN-bus BMS data or when MeterValues packets were dropped during poor cellular/Wi-Fi signal.',
        });
      }
    } else if (rawStartSoc === null && rawStopSoc !== null && reason === 'PowerLoss') {
      badges.push({ text: `🔋 Stale End SoC (${rawStopSoc}%)`, severity: 'warning' });
      items.push({
        code: 'SOC_LATE_STALE',
        severity: 'warning',
        badge: 'Stale End SoC',
        title: `Late SoC Sampled on Auto-Close (None → ${rawStopSoc}%)`,
        reason: `No starting SoC was recorded for this duplicate record, and when the PowerLoss watchdog auto-closed it later, it read the ${rawStopSoc}% SoC of the next vehicle connected to the gun.`,
      });
    } else if (rawStartSoc !== null && rawStopSoc !== null && rawStartSoc > 0 && rawStartSoc === rawStopSoc && energyKwh >= 3.0) {
      badges.push({ text: `🔋 Frozen SoC (${rawStartSoc}%→${rawStopSoc}%)`, severity: 'warning' });
      items.push({
        code: 'SOC_FROZEN',
        severity: 'warning',
        badge: 'Frozen SoC',
        title: `Unchanged Battery SoC (${rawStartSoc}% → ${rawStopSoc}%) Despite ${energyKwh.toFixed(2)} kWh Delivered`,
        reason: `The charger delivered ${energyKwh.toFixed(2)} kWh (${(energyKwh * 1000).toFixed(0)} Wh) of verified energy, but the reported SoC stayed constant at ${rawStartSoc}%. This occurs when a vehicle/adapter reports a fixed placeholder SoC (such as 10%) over the pilot/CAN line, or when stale connector SoC memory was latched without live BMS updates.`,
      });
    } else if (rawStartSoc === 0 && rawStopSoc !== null && rawStopSoc > 5) {
      badges.push({ text: '🔋 0% Init Handshake', severity: 'info' });
      items.push({
        code: 'SOC_ZERO_INIT',
        severity: 'info',
        badge: '0% Start SoC',
        title: `Initial 0% SoC Sampled Before DC Voltage Ramp (0% → ${rawStopSoc}%)`,
        reason: `At the very beginning of the session (Preparing / Cable Check phase before DC output reached >= 100V), the charger reported 0% before the vehicle's BMS transmitted its true starting battery percentage.`,
      });
    }
  }

  // 4. Zero Energy Completed Session
  if (isCompleted && energyKwh === 0) {
    badges.push({ text: '⚠️ 0 kWh Handshake Only', severity: 'warning' });
    items.push({
      code: 'ZERO_ENERGY',
      severity: 'warning',
      badge: '0 kWh Delivered',
      title: 'Zero Energy Delivered (0.00 kWh)',
      reason: 'The transaction started and stopped without transferring energy. This typically happens when the cable handshake fails, the vehicle rejects charging (doors unlocked / charge limit already met), or the user stops the session immediately.',
    });
  }

  // 5. Check Charger Clock +5h Offset ("Z" tag on local PKT clock)
  let clockOffsetHours: number | null = null;
  if (tx.startTime && tx.createdAt) {
    const hwMs = new Date(tx.startTime).getTime();
    const srvMs = new Date(tx.createdAt).getTime();
    if (!isNaN(hwMs) && !isNaN(srvMs)) {
      const diffHours = (hwMs - srvMs) / (1000 * 3600);
      if (Math.abs(diffHours - 5) <= 0.6) {
        clockOffsetHours = Number(diffHours.toFixed(1));
        items.push({
          code: 'CLOCK_OFFSET_PKT_Z',
          severity: 'info',
          badge: 'Clock +5h Z-Tag',
          title: 'Charger Internal Clock UTC/PKT Tag Offset (+5h Auto-Corrected)',
          reason: `The charger's internal clock is set to Pakistan Standard Time (UTC+5) but appends a "Z" (UTC) suffix (${tx.startTime}). The app automatically corrects the displayed time using the server's verified Karachi timestamp.`,
        });
      }
    }
  }

  let highestSeverity: 'normal' | 'info' | 'warning' | 'error' = 'normal';
  for (const item of items) {
    if (item.severity === 'error') {
      highestSeverity = 'error';
      break;
    }
    if (item.severity === 'warning') {
      highestSeverity = 'warning';
    } else if (item.severity === 'info' && highestSeverity === 'normal') {
      highestSeverity = 'info';
    }
  }

  // Consider session visually abnormal if there is any error, warning, or duplicate/SoC issue (excluding pure clock offset info if everything else is normal)
  const nonClockItems = items.filter((i) => i.code !== 'CLOCK_OFFSET_PKT_Z');
  const isAbnormal = nonClockItems.length > 0;

  return {
    isAbnormal,
    highestSeverity,
    badges,
    items,
    recoveredStartSoc,
    recoveredStopSoc,
    recoveredFromTxId,
    siblingIds,
    clockOffsetHours,
  };
}

export default function HistoryScreen() {
  const { chargerId, user } = useAuth();
  const CHARGER_ID = (chargerId || user?.stationId || user?.defaultChargerId || 'charger1').trim().toLowerCase();

  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dataSource, setDataSource] = useState<'local' | 'cloud'>('local');
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null);

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
            let exactDurationDetail = '';
            if (isCompleted && effectiveDiffMs > 0) {
              const mins = Math.max(1, Math.round(effectiveDiffMs / 60000));
              durationText = `${mins} min`;
              const totalSecs = Math.round(effectiveDiffMs / 1000);
              const dMins = Math.floor(totalSecs / 60);
              const dSecs = totalSecs % 60;
              exactDurationDetail = `${dMins}m ${dSecs}s`;
            } else if (!isCompleted && startDate) {
              const liveDiffMs = Math.max(0, Date.now() - startDate.getTime());
              const mins = Math.max(1, Math.round(liveDiffMs / 60000));
              durationText = `${mins} min`;
              exactDurationDetail = `${mins}m (live)`;
            }

            const gunLabel = tx.connectorId === 2 ? 'Gun B' : 'Gun A';
            const txKey = String(tx.transactionId || tx.id || '');
            const isExpanded = expandedTxId === txKey;
            const diagnostics = analyzeSessionAbnormalities(tx, transactions, energy);
            const stopReasonInfo = getStopReasonDescription(tx.reason, isCompleted);

            const meterStartWh = typeof tx.meterStart === 'number' ? tx.meterStart : Number(tx.meterStart) || 0;
            const meterStopWh = typeof tx.meterStop === 'number' ? tx.meterStop : Number(tx.meterStop) || 0;
            const meterDeltaWh = meterStopWh > meterStartWh ? meterStopWh - meterStartWh : Math.round(energy * 1000);

            const fullStartStr = startDate
              ? startDate.toLocaleString('en-PK', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })
              : 'N/A';
            const fullStopStr =
              isCompleted && stopDate
                ? stopDate.toLocaleString('en-PK', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })
                : isCompleted
                ? 'N/A'
                : 'Currently Charging';

            return (
              <TouchableOpacity
                key={txKey}
                activeOpacity={0.85}
                onPress={() => setExpandedTxId(isExpanded ? null : txKey)}
                style={[
                  styles.txCard,
                  diagnostics.highestSeverity === 'error' && styles.txCardError,
                  diagnostics.highestSeverity === 'warning' && styles.txCardWarning,
                  isExpanded && styles.txCardExpanded,
                ]}
              >
                <View style={styles.txHeader}>
                  <View style={styles.txHeaderLeft}>
                    <View style={styles.gunBadge}>
                      <Text style={styles.gunBadgeText}>{gunLabel}</Text>
                    </View>
                    <Text style={styles.txId}>#{txKey}</Text>
                    {tx.reason && isCompleted && (
                      <View
                        style={[
                          styles.reasonMiniTag,
                          stopReasonInfo.isAbnormalStop ? styles.reasonMiniTagWarn : styles.reasonMiniTagNormal,
                        ]}
                      >
                        <Text
                          style={[
                            styles.reasonMiniTagText,
                            stopReasonInfo.isAbnormalStop ? styles.reasonMiniTagTextWarn : styles.reasonMiniTagTextNormal,
                          ]}
                        >
                          {tx.reason}
                        </Text>
                      </View>
                    )}
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

                {/* Abnormality Badges Row (if any abnormality detected) */}
                {diagnostics.badges.length > 0 && (
                  <View style={styles.abnormalityBadgesRow}>
                    {diagnostics.badges.map((b, idx) => (
                      <View
                        key={idx}
                        style={[
                          styles.abnormalityPill,
                          b.severity === 'error'
                            ? styles.abnormalityPillError
                            : b.severity === 'warning'
                            ? styles.abnormalityPillWarning
                            : styles.abnormalityPillInfo,
                        ]}
                      >
                        <Text
                          style={[
                            styles.abnormalityPillText,
                            b.severity === 'error'
                              ? styles.abnormalityPillTextError
                              : b.severity === 'warning'
                              ? styles.abnormalityPillTextWarning
                              : styles.abnormalityPillTextInfo,
                          ]}
                        >
                          {b.text}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}

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

                    {/* Battery Percentage Journey (Start -> End, or Recovered from Sibling) */}
                    {(() => {
                      const rawStart = typeof tx.socStart === 'number' && tx.socStart > 0 ? tx.socStart : (typeof tx.soc_start === 'number' && tx.soc_start > 0 ? tx.soc_start : null);
                      const rawStop = typeof tx.socStop === 'number' && tx.socStop > 0
                        ? tx.socStop
                        : (typeof tx.soc_stop === 'number' && tx.soc_stop > 0
                          ? tx.soc_stop
                          : typeof tx.socCurrent === 'number' && tx.socCurrent > 0
                          ? tx.socCurrent
                          : typeof tx.soc_current === 'number' && tx.soc_current > 0
                          ? tx.soc_current
                          : null);

                      const startSoc = rawStart ?? diagnostics.recoveredStartSoc;
                      const stopSoc = rawStop ?? diagnostics.recoveredStopSoc;
                      const isRecovered = !rawStart && !rawStop && Boolean(diagnostics.recoveredFromTxId);

                      if (startSoc && stopSoc) {
                        const gained = stopSoc >= startSoc ? Number((stopSoc - startSoc).toFixed(1)) : 0;
                        return (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 2, flexWrap: 'wrap' }}>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>
                              🔋 {startSoc}% → {stopSoc}%
                            </Text>
                            {gained > 0 ? (
                              <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>
                                +{gained}%
                              </Text>
                            ) : (
                              <Text style={{ fontSize: 11, fontWeight: '700', color: '#D97706' }}>
                                (0% change)
                              </Text>
                            )}
                            {isRecovered && (
                              <Text style={{ fontSize: 10, fontWeight: '700', color: '#0284C7' }}>
                                (from {diagnostics.recoveredFromTxId})
                              </Text>
                            )}
                          </View>
                        );
                      }

                      if (startSoc) {
                        return (
                          <View style={{ marginVertical: 2 }}>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>
                              🔋 Start: {startSoc}%
                            </Text>
                          </View>
                        );
                      }

                      if (stopSoc) {
                        return (
                          <View style={{ marginVertical: 2 }}>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>
                              🔋 End: {stopSoc}%
                            </Text>
                          </View>
                        );
                      }

                      return (
                        <View style={{ marginVertical: 2 }}>
                          <Text style={{ fontSize: 11, fontWeight: '600', color: '#94A3B8' }}>
                            🔋 SoC: Not reported
                          </Text>
                        </View>
                      );
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

                {/* Tap Prompt Footer */}
                <View style={styles.tapPromptRow}>
                  <Text
                    style={[
                      styles.tapPromptText,
                      diagnostics.isAbnormal && { color: '#B45309', fontWeight: '800' },
                    ]}
                  >
                    {diagnostics.isAbnormal
                      ? isExpanded
                        ? '▲ Hide Session Details & Abnormality Reason'
                        : `⚠️ ${diagnostics.items.length} Diagnostic Note(s) · Tap for Abnormality Reason ▼`
                      : isExpanded
                      ? '▲ Hide Session Details & Diagnostics'
                      : '✓ Normal Session · Tap for Full Details & Diagnostics ▼'}
                  </Text>
                </View>

                {/* Expanded Session Details & Abnormality Reason Panel */}
                {isExpanded && (
                  <View style={styles.expandedPanel}>
                    {/* 1. Abnormality / Diagnostic Reasons Section */}
                    <Text style={styles.expandedSectionTitle}>
                      SESSION DIAGNOSTICS & ABNORMALITY ANALYSIS
                    </Text>

                    {diagnostics.items.length === 0 ? (
                      <View style={styles.diagNormalCard}>
                        <Text style={styles.diagNormalTitle}>
                          ✅ Normal Charging Session — No Abnormalities
                        </Text>
                        <Text style={styles.diagNormalDesc}>
                          Hardware energy meter registers ({meterStartWh.toLocaleString()} → {meterStopWh.toLocaleString()} Wh), OCPP start/stop handshake ({stopReasonInfo.label}), and session timing completed cleanly without any data discrepancy.
                        </Text>
                      </View>
                    ) : (
                      <View style={{ gap: 8, marginBottom: 12 }}>
                        {diagnostics.items.map((item, idx) => (
                          <View
                            key={idx}
                            style={[
                              styles.diagItemCard,
                              item.severity === 'error'
                                ? styles.diagItemCardError
                                : item.severity === 'warning'
                                ? styles.diagItemCardWarning
                                : styles.diagItemCardInfo,
                            ]}
                          >
                            <View style={styles.diagItemHeader}>
                              <Text
                                style={[
                                  styles.diagItemBadge,
                                  item.severity === 'error'
                                    ? { color: '#991B1B', backgroundColor: '#FEE2E2' }
                                    : item.severity === 'warning'
                                    ? { color: '#92400E', backgroundColor: '#FEF3C7' }
                                    : { color: '#075985', backgroundColor: '#E0F2FE' },
                                ]}
                              >
                                {item.badge.toUpperCase()}
                              </Text>
                              <Text style={styles.diagItemTitle}>{item.title}</Text>
                            </View>
                            <Text style={styles.diagItemReason}>{item.reason}</Text>
                          </View>
                        ))}
                      </View>
                    )}

                    {/* 2. Stop Reason Explanation */}
                    <View style={styles.stopReasonBox}>
                      <Text style={styles.stopReasonBoxTitle}>
                        STOP REASON: {stopReasonInfo.label.toUpperCase()} ({tx.reason || (isCompleted ? 'Local' : 'Active')})
                      </Text>
                      <Text style={styles.stopReasonBoxDesc}>{stopReasonInfo.desc}</Text>
                    </View>

                    {/* 3. Full Technical Breakdown Table */}
                    <Text style={[styles.expandedSectionTitle, { marginTop: 12 }]}>
                      COMPLETE TECHNICAL BREAKDOWN
                    </Text>

                    <View style={styles.techGrid}>
                      <View style={styles.techRow}>
                        <Text style={styles.techLabel}>Transaction ID</Text>
                        <Text style={styles.techValue}>
                          #{txKey}
                          {diagnostics.siblingIds.length > 0
                            ? ` (Siblings: ${diagnostics.siblingIds.join(', ')})`
                            : ''}
                        </Text>
                      </View>

                      <View style={styles.techRow}>
                        <Text style={styles.techLabel}>Connector / Gun</Text>
                        <Text style={styles.techValue}>
                          {gunLabel} (Connector #{tx.connectorId || 1})
                        </Text>
                      </View>

                      <View style={styles.techRow}>
                        <Text style={styles.techLabel}>Start Time (PKT)</Text>
                        <Text style={styles.techValue}>{fullStartStr}</Text>
                      </View>

                      <View style={styles.techRow}>
                        <Text style={styles.techLabel}>Stop Time (PKT)</Text>
                        <Text style={styles.techValue}>{fullStopStr}</Text>
                      </View>

                      <View style={styles.techRow}>
                        <Text style={styles.techLabel}>Exact Duration</Text>
                        <Text style={styles.techValue}>
                          {exactDurationDetail || durationText || 'N/A'}
                        </Text>
                      </View>

                      <View style={styles.techRow}>
                        <Text style={styles.techLabel}>Meter Start → Stop</Text>
                        <Text style={styles.techValue}>
                          {meterStartWh > 0 ? `${meterStartWh.toLocaleString()} Wh` : '0 Wh'} →{' '}
                          {meterStopWh > 0 ? `${meterStopWh.toLocaleString()} Wh` : 'In Progress'}
                        </Text>
                      </View>

                      <View style={styles.techRow}>
                        <Text style={styles.techLabel}>Delivered Energy</Text>
                        <Text style={[styles.techValue, { color: '#0284C7', fontWeight: '900' }]}>
                          {energy.toFixed(3)} kWh ({meterDeltaWh.toLocaleString()} Wh)
                        </Text>
                      </View>

                      <View style={styles.techRow}>
                        <Text style={styles.techLabel}>Tariff & Total Cost</Text>
                        <Text style={[styles.techValue, { color: '#0F172A', fontWeight: '900' }]}>
                          PKR {rate}/kWh → PKR {cost.toFixed(2)}
                        </Text>
                      </View>

                      <View style={styles.techRow}>
                        <Text style={styles.techLabel}>Battery SoC (BMS)</Text>
                        <Text style={styles.techValue}>
                          {tx.socStart !== null && tx.socStart !== undefined
                            ? `${tx.socStart}%`
                            : 'None'}{' '}
                          →{' '}
                          {tx.socStop !== null && tx.socStop !== undefined
                            ? `${tx.socStop}%`
                            : tx.socCurrent !== null && tx.socCurrent !== undefined
                            ? `${tx.socCurrent}%`
                            : 'None'}
                          {diagnostics.recoveredFromTxId
                            ? ` (Recovered: ${diagnostics.recoveredStartSoc}% → ${diagnostics.recoveredStopSoc}% on ${diagnostics.recoveredFromTxId})`
                            : ''}
                        </Text>
                      </View>

                      {tx.currentPowerKw !== undefined && tx.currentPowerKw !== null && (
                        <View style={styles.techRow}>
                          <Text style={styles.techLabel}>Last Recorded Power</Text>
                          <Text style={styles.techValue}>{Number(tx.currentPowerKw).toFixed(2)} kW</Text>
                        </View>
                      )}

                      <View style={styles.techRow}>
                        <Text style={styles.techLabel}>RFID / Auth ID Tag</Text>
                        <Text style={styles.techValue}>{tx.idTag || 'AppUser'}</Text>
                      </View>

                      {tx.startTime && (
                        <View style={[styles.techRow, { borderBottomWidth: 0 }]}>
                          <Text style={styles.techLabel}>Raw Charger Clock</Text>
                          <Text style={[styles.techValue, { fontSize: 10, color: '#64748B' }]}>
                            {tx.startTime}
                            {tx.stopTime ? ` → ${tx.stopTime}` : ''}
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                )}
              </TouchableOpacity>
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
  txCardError: {
    borderColor: '#FCA5A5',
    backgroundColor: '#FFFDFD',
  },
  txCardWarning: {
    borderColor: '#FCD34D',
    backgroundColor: '#FFFEFA',
  },
  txCardExpanded: {
    borderColor: '#0284C7',
    borderWidth: 1.5,
  },
  reasonMiniTag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  reasonMiniTagNormal: {
    backgroundColor: '#F8FAFC',
    borderColor: '#E2E8F0',
  },
  reasonMiniTagWarn: {
    backgroundColor: '#FEF3C7',
    borderColor: '#FDE68A',
  },
  reasonMiniTagText: {
    fontSize: 9,
    fontWeight: '800',
  },
  reasonMiniTagTextNormal: {
    color: '#64748B',
  },
  reasonMiniTagTextWarn: {
    color: '#B45309',
  },
  abnormalityBadgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  abnormalityPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  abnormalityPillError: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  abnormalityPillWarning: {
    backgroundColor: '#FFFBEB',
    borderColor: '#FDE68A',
  },
  abnormalityPillInfo: {
    backgroundColor: '#F0F9FF',
    borderColor: '#BAE6FD',
  },
  abnormalityPillText: {
    fontSize: 10,
    fontWeight: '800',
  },
  abnormalityPillTextError: {
    color: '#B91C1C',
  },
  abnormalityPillTextWarning: {
    color: '#B45309',
  },
  abnormalityPillTextInfo: {
    color: '#0369A1',
  },
  tapPromptRow: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    alignItems: 'center',
  },
  tapPromptText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 0.2,
  },
  expandedPanel: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
  },
  expandedSectionTitle: {
    fontSize: 10,
    fontWeight: '900',
    color: '#475569',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  diagNormalCard: {
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  diagNormalTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#065F46',
    marginBottom: 4,
  },
  diagNormalDesc: {
    fontSize: 11,
    color: '#047857',
    lineHeight: 16,
    fontWeight: '500',
  },
  diagItemCard: {
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
  },
  diagItemCardError: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  diagItemCardWarning: {
    backgroundColor: '#FFFBEB',
    borderColor: '#FDE68A',
  },
  diagItemCardInfo: {
    backgroundColor: '#F0F9FF',
    borderColor: '#BAE6FD',
  },
  diagItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
  },
  diagItemBadge: {
    fontSize: 9,
    fontWeight: '900',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
    letterSpacing: 0.4,
  },
  diagItemTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0F172A',
    flex: 1,
  },
  diagItemReason: {
    fontSize: 11,
    color: '#334155',
    lineHeight: 17,
    fontWeight: '500',
  },
  stopReasonBox: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    padding: 10,
  },
  stopReasonBoxTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 2,
    letterSpacing: 0.3,
  },
  stopReasonBoxDesc: {
    fontSize: 11,
    color: '#475569',
    lineHeight: 16,
  },
  techGrid: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  techRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    gap: 10,
  },
  techLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
  },
  techValue: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0F172A',
    textAlign: 'right',
    flex: 1,
  },
});
