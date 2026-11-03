import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Platform,
  Image,
  TouchableOpacity,
} from 'react-native';
import { router, Redirect } from 'expo-router';
import { subscribeToLiveStatus } from '@/config/api';
import { scheduleLocalNotification } from '@/services/notifications';
import { useAuth } from '@/config/auth';
import {
  getLocalChargerData,
  saveLocalChargerData,
  getLocalConnectorData,
  saveLocalConnectorData,
  getLocalActiveTx,
  saveLocalActiveTx,
  getLocalTransactions,
  mergeLocalTransaction,
} from '@/services/storage';
import { DashboardSkeleton } from '@/components/skeleton';
import { useSimulator } from '@/config/simulator';
import { SimulatorModal } from '@/components/SimulatorModal';
import { SwipeableTabScreen } from '@/components/SwipeableTabScreen';
import {
  AnimatedMetricValue,
} from '@/components/motion/MotionGraphics';

const STATE_IMAGES = {
  idle: require('@/assets/images/states/state_idle.png'),
  left: require('@/assets/images/states/state_left.png'),
  right: require('@/assets/images/states/state_right.png'),
  both: require('@/assets/images/states/state_both.png'),
};

const STATE_IMAGES_30KW = {
  idle: require('@/assets/images/states/state_30kw_idle.png'),
  connected: require('@/assets/images/states/state_30kw_connected.png'),
};

const STATE_IMAGES_240KW = {
  idle: require('@/assets/images/states/state_240kw_idle.png'),
  left: require('@/assets/images/states/state_240kw_left.png'),
  right: require('@/assets/images/states/state_240kw_right.png'),
  both: require('@/assets/images/states/state_240kw_both.png'),
};

type CarState = 'idle' | 'left' | 'right' | 'both';

const STATUS_CONFIG: Record<
  string,
  {
    color: string;
    label: string;
    bg: string;
    border: string;
  }
> = {
  Charging: { color: '#059669', label: 'CHARGING', bg: 'rgba(16, 185, 129, 0.08)', border: 'rgba(16, 185, 129, 0.25)' },
  Preparing: { color: '#D97706', label: 'PLUGGED IN', bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.25)' },
  SuspendedEV: { color: '#6366F1', label: 'PAUSED', bg: 'rgba(99, 102, 241, 0.08)', border: 'rgba(99, 102, 241, 0.25)' },
  SuspendedEVSE: { color: '#6366F1', label: 'PAUSED', bg: 'rgba(99, 102, 241, 0.08)', border: 'rgba(99, 102, 241, 0.25)' },
  Finishing: { color: '#0284C7', label: 'COMPLETED', bg: 'rgba(2, 132, 199, 0.08)', border: 'rgba(2, 132, 199, 0.25)' },
  Available: { color: '#475569', label: 'AVAILABLE', bg: 'rgba(100, 116, 139, 0.06)', border: 'rgba(100, 116, 139, 0.15)' },
  Reserved: { color: '#D97706', label: 'RESERVED', bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.25)' },
  Unavailable: { color: '#94A3B8', label: 'OFFLINE', bg: 'rgba(148, 163, 184, 0.06)', border: 'rgba(148, 163, 184, 0.15)' },
  Faulted: { color: '#DC2626', label: 'FAULT', bg: 'rgba(220, 38, 38, 0.08)', border: 'rgba(220, 38, 38, 0.25)' },
};

// Fix Issue 6: Fallback badge getter so unknown statuses never crash the UI
export const getStatusConfig = (status?: string) => {
  if (!status) return STATUS_CONFIG.Available;
  return (
    STATUS_CONFIG[status] || {
      color: '#475569',
      label: String(status).toUpperCase(),
      bg: 'rgba(100, 116, 139, 0.06)',
    }
  );
};

// Compact status label for dual-column view to prevent any text wrapping
export const getDualStatusLabel = (label: string) => {
  const upper = (label || '').toUpperCase();
  if (upper === 'PLUGGED IN') return 'PLUGGED';
  if (upper === 'AVAILABLE') return 'READY';
  return upper;
};

export default function HomeScreen() {
  const {
    chargerId: configuredId,
    chargerModel,
    stationLocation,
    isAuthenticated,
    isConfigured,
    isLoading: authLoading,
    user,
    logout,
    tariffRate,
    currency,
  } = useAuth();

  const CHARGER_ID = configuredId || '';

  const [chargerData, setChargerData] = useState<any>(null);
  const [connector1Data, setConnector1Data] = useState<any>(null);
  const [connector2Data, setConnector2Data] = useState<any>(null);
  const [activeTxData, setActiveTxData] = useState<any>(null);
  const [activeTx1Data, setActiveTx1Data] = useState<any>(null);
  const [activeTx2Data, setActiveTx2Data] = useState<any>(null);
  const [lastCompletedTx, setLastCompletedTx] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isIdentifying, setIsIdentifying] = useState(true);
  const [isServerReachable, setIsServerReachable] = useState<boolean | null>(null);
  const [isWebSocketConnected, setIsWebSocketConnected] = useState<boolean>(true);
  const [serverTimeOffset, setServerTimeOffset] = useState<number>(0);
  const [liveAccumulatedA, setLiveAccumulatedA] = useState<number>(0);
  const [liveAccumulatedB, setLiveAccumulatedB] = useState<number>(0);

  // In-app UI Simulator hook for desk testing without physical cars
  const { scenario, isSimulating, gunA: simGunA, gunB: simGunB } = useSimulator();
  const [simModalVisible, setSimModalVisible] = useState(false);

  const prevStatus1Ref = useRef<string | null>(null);
  const prevStatus2Ref = useRef<string | null>(null);
  const prevActiveTxIdRef = useRef<string | null>(null);
  const mountTimeRef = useRef(Date.now());
  const initialResolvedRef = useRef(false);

  // Initial identification resolver: ensures skeleton stays visible for minimum 1.2s
  // so server reachability, charger connectivity, and live conditions are all calculated.
  const resolveIdentification = useCallback(() => {
    if (initialResolvedRef.current) return;
    initialResolvedRef.current = true;

    const MIN_IDENTIFY_MS = 1200;
    const elapsed = Date.now() - mountTimeRef.current;
    const remaining = Math.max(0, MIN_IDENTIFY_MS - elapsed);

    setTimeout(() => {
      setLoading(false);
      setIsIdentifying(false);
    }, remaining);
  }, []);

  const consecutiveFailuresRef = useRef(0);

  // Safety fallback: Ensure skeleton loader never hangs indefinitely if network is completely down
  useEffect(() => {
    const safetyTimer = setTimeout(() => {
      if (!initialResolvedRef.current) {
        setIsServerReachable((prev) => (prev === null ? false : prev));
        resolveIdentification();
      }
    }, 4500);
    return () => clearTimeout(safetyTimer);
  }, [resolveIdentification]);

  useEffect(() => {
    if (!CHARGER_ID || !isAuthenticated) return;

    let isMounted = true;

    // 1. Read from local storage in background for fallback without dismissing the skeleton
    getLocalChargerData(CHARGER_ID).then((local) => {
      if (isMounted && local) {
        setChargerData((prev: any) => prev || local);
      }
    });
    getLocalConnectorData(CHARGER_ID, '1').then((d) => {
      if (isMounted && d) setConnector1Data((prev: any) => prev || d);
    });
    getLocalConnectorData(CHARGER_ID, '2').then((d) => {
      if (isMounted && d) setConnector2Data((prev: any) => prev || d);
    });
    getLocalActiveTx(CHARGER_ID).then((tx) => {
      if (isMounted && tx && tx.status === 'Charging') setActiveTxData((prev: any) => prev || tx);
    });
    getLocalTransactions(CHARGER_ID, user?.uid).then((list) => {
      if (isMounted && list && list.length > 0) {
        const valid = list.find((tx: any) => {
          const id = String(tx.transactionId || tx.id || '').trim();
          if (id === '275384' || id === '72089') return false;
          return Number(tx.energyDeliveredKwh) > 0 || Number(tx.energyDeliveredWh) > 0;
        });
        if (valid) {
          setLastCompletedTx((prev: any) => prev || valid);
        }
      }
    });

    // 2. Direct Server Live Status Stream / Polling
    const unsubscribe = subscribeToLiveStatus(
      CHARGER_ID,
      (data) => {
        if (!isMounted || !data) return;
        consecutiveFailuresRef.current = 0;
        setIsServerReachable(true);

        const live = data.live || {};

        if (data.serverTime) {
          const serverMs = new Date(data.serverTime).getTime();
          if (!isNaN(serverMs)) {
            setServerTimeOffset(serverMs - Date.now());
          }
        }

        const charger = data.charger || live.charger;
        if (charger) {
          setChargerData(charger);
          saveLocalChargerData(CHARGER_ID, charger);
        }

        if (typeof data.isConnected === 'boolean') {
          setIsWebSocketConnected(data.isConnected);
        } else if (charger?.status) {
          setIsWebSocketConnected(charger.status === 'Online');
        }

        const rawConnectors = data.connectors || live.connectors;
        const connectorsList = Array.isArray(rawConnectors)
          ? rawConnectors
          : Object.values(rawConnectors || {});
        const c1 = connectorsList.find((c: any) => Number(c.connectorId) === 1);
        const c2 = connectorsList.find((c: any) => Number(c.connectorId) === 2);

        if (c1) {
          setConnector1Data(c1);
          saveLocalConnectorData(CHARGER_ID, '1', c1);
          if (c1.activeTx && c1.status === 'Charging') {
            setActiveTx1Data(c1.activeTx);
          } else {
            setActiveTx1Data(null);
          }

          const oldStatus1 = prevStatus1Ref.current;
          prevStatus1Ref.current = c1.status;

          if (oldStatus1 !== null && oldStatus1 !== c1.status) {
            if (c1.status === 'Preparing') {
              scheduleLocalNotification('🔌 Vehicle Connected', 'A vehicle was plugged into Gun A.');
            } else if (c1.status === 'Charging') {
              scheduleLocalNotification('⚡ Charging Started', 'Vehicle is charging on Gun A.');
            } else if ((oldStatus1 === 'Charging' || oldStatus1 === 'Preparing') && c1.status === 'Available') {
              scheduleLocalNotification('✅ Charging Completed', 'Vehicle finished charging on Gun A.');
            }
          }
        }

        if (c2) {
          setConnector2Data(c2);
          saveLocalConnectorData(CHARGER_ID, '2', c2);
          if (c2.activeTx && c2.status === 'Charging') {
            setActiveTx2Data(c2.activeTx);
          } else {
            setActiveTx2Data(null);
          }

          const oldStatus2 = prevStatus2Ref.current;
          prevStatus2Ref.current = c2.status;

          if (oldStatus2 !== null && oldStatus2 !== c2.status) {
            if (c2.status === 'Preparing') {
              scheduleLocalNotification('🔌 Vehicle Connected', 'A vehicle was plugged into Gun B.');
            } else if (c2.status === 'Charging') {
              scheduleLocalNotification('⚡ Charging Started', 'Vehicle is charging on Gun B.');
            } else if ((oldStatus2 === 'Charging' || oldStatus2 === 'Preparing') && c2.status === 'Available') {
              scheduleLocalNotification('✅ Charging Completed', 'Vehicle finished charging on Gun B.');
            }
          }
        }

        const active = data.activeTransaction || live.activeTransaction || c1?.activeTx || c2?.activeTx;
        if (active && (active.status === 'Charging' || Number(active.currentPowerKw || 0) > 0)) {
          const primaryTx = (c2?.status === 'Charging' && active.connector_id === 2)
            ? active
            : (c1?.status === 'Charging' && active.connector_id === 1)
            ? active
            : active;
          setActiveTxData(primaryTx);
          saveLocalActiveTx(CHARGER_ID, primaryTx);

          // Notify when a new active transaction ID appears
          const txIdStr = String(primaryTx.transactionId || primaryTx.transaction_id || primaryTx.id || '');
          if (txIdStr && txIdStr !== prevActiveTxIdRef.current) {
            prevActiveTxIdRef.current = txIdStr;
            const gunLabel = Number(primaryTx.connectorId || primaryTx.connector_id) === 2 ? 'Gun B' : 'Gun A';
            scheduleLocalNotification('⚡ Charging Started', `Vehicle started charging on ${gunLabel} (Session #${txIdStr}).`);
          }
        } else {
          if (prevActiveTxIdRef.current) {
            prevActiveTxIdRef.current = null;
            scheduleLocalNotification('✅ Charging Completed', 'Charging session has finished.');
          }
          setActiveTxData(null);
        }

        const completed = data.lastCompletedTx || live.lastCompletedTx;
        if (completed) {
          const done = completed;
          const doneId = String(done.transaction_id || done.transactionId || done.id || '');
          if (doneId !== '275384' && doneId !== '72089') {
            const formatted = {
              id: doneId,
              transactionId: doneId,
              connectorId: done.connector_id || done.connectorId || 1,
              energyDeliveredKwh: done.energy_kwh ?? done.energyDeliveredKwh ?? 0,
              cost: done.cost ?? 0,
              startTime: done.start_time || done.startTime,
              stopTime: done.stop_time || done.stopTime,
              status: done.status || 'Completed',
              idTag: done.id_tag || done.idTag || '',
            };
            setLastCompletedTx(formatted);
            mergeLocalTransaction(CHARGER_ID, formatted, user?.uid);
          }
        }

        // Live calculation finished -> resolve identification on the skeleton
        resolveIdentification();
      },
      (err) => {
        if (!isMounted) return;
        consecutiveFailuresRef.current += 1;
        if (consecutiveFailuresRef.current >= 3) {
          setIsServerReachable(false);
        }
        resolveIdentification();
      }
    );

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [CHARGER_ID, isAuthenticated, user?.uid, resolveIdentification]);

  // 30kW single-gun detection
  const is30kW =
    chargerModel?.toLowerCase().includes('30') ||
    chargerData?.model?.toLowerCase().includes('30');

  // Connected statuses list: Preparing, Charging, Suspended, Finishing
  const CONNECTED_STATUS_LIST = ['Charging', 'Preparing', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'];

  const rawStatus1 = isSimulating ? simGunA.status : connector1Data?.status || 'Available';
  const rawStatus2 = isSimulating ? simGunB.status : connector2Data?.status || 'Available';

  const isGunAPlugged = CONNECTED_STATUS_LIST.includes(rawStatus1);
  const isGunBPlugged = !is30kW && CONNECTED_STATUS_LIST.includes(rawStatus2);
  const isActivelyEngaged = isGunAPlugged || isGunBPlugged;

  // Helper to determine if charger is actively alive and connected
  const isChargerStatusAlive = () => {
    const s = String(chargerData?.status || '').toLowerCase();
    return s === 'online' || s === 'available' || s === 'charging' || s === 'preparing' || s === 'suspendedev' || s === 'suspendedevse';
  };

  const isChargerHeartbeatFresh = () => {
    const hb = chargerData?.lastHeartbeat || chargerData?.last_heartbeat;
    if (!hb) return false;
    const diffMs = Math.abs(Date.now() - new Date(hb).getTime());
    return diffMs < 180000; // within 3 minutes
  };

  const hasLiveConnectorActivity =
    (connector1Data && connector1Data.status && connector1Data.status !== 'Unavailable') ||
    (connector2Data && connector2Data.status && connector2Data.status !== 'Unavailable');

  // Track true server connectivity and charger online status
  const isOnline = isSimulating || (
    isServerReachable !== false &&
    (isWebSocketConnected === true ||
      isChargerStatusAlive() ||
      Boolean(chargerData?.isOnline) ||
      hasLiveConnectorActivity ||
      isChargerHeartbeatFresh())
  );

  const status1 = isOnline ? rawStatus1 : 'Unavailable';
  const status2 = isOnline && !is30kW ? rawStatus2 : 'Unavailable';

  const isGunAConnected = isOnline && isGunAPlugged;
  const isGunBConnected = isOnline && isGunBPlugged;
  const bothConnected = isOnline && !is30kW && isGunAConnected && isGunBConnected;

  // 240kW / 220kW model detection
  const is240kW =
    chargerModel?.toLowerCase().includes('240') ||
    chargerModel?.toLowerCase().includes('220') ||
    chargerModel === 'DC_EVSE' ||
    chargerData?.model?.toLowerCase().includes('240') ||
    chargerData?.model?.toLowerCase().includes('220') ||
    chargerData?.model === 'DC_EVSE';

  // Dynamically select the correct hero image based on active gun connection states
  let heroImageSource: any;
  if (!isOnline) {
    heroImageSource = is30kW ? STATE_IMAGES_30KW.idle : (is240kW ? STATE_IMAGES_240KW.idle : STATE_IMAGES.idle);
  } else if (is30kW) {
    // 30kW has only one gun: connected when in use/plugged, idle when standby
    heroImageSource = isGunAConnected ? STATE_IMAGES_30KW.connected : STATE_IMAGES_30KW.idle;
  } else {
    // Multi-gun models (60kW, 240kW)
    let carState: CarState = 'idle';
    if (bothConnected) {
      carState = 'both';
    } else if (isGunAConnected) {
      carState = 'left';
    } else if (isGunBConnected) {
      carState = 'right';
    }
    const imgSet = is240kW ? STATE_IMAGES_240KW : STATE_IMAGES;
    heroImageSource = imgSet[carState];
  }
  const safeHeroImage =
    heroImageSource || (is30kW ? STATE_IMAGES_30KW.idle : STATE_IMAGES.idle);

  // Fix Issue 6: Use safe getStatusConfig so custom/unknown statuses never crash the app
  const themeA = getStatusConfig(status1);
  const themeB = getStatusConfig(status2);

  // Primary state config for top header indication
  const activeStatus = !isOnline
    ? 'Unavailable'
    : is30kW
    ? isGunAConnected
      ? status1
      : 'Available'
    : bothConnected
    ? status1 === 'Charging' || status2 === 'Charging'
      ? 'Charging'
      : status1
    : isGunAConnected
    ? status1
    : isGunBConnected
    ? status2
    : 'Available';
  const activeTheme = getStatusConfig(activeStatus);

  // Telemetry for Gun A (Connector 1) - directly from live OCPP server or simulator
  const tel1 = connector1Data?.telemetry;
  const powerA = isSimulating ? simGunA.powerKw : Number(tel1?.powerKw || 0);
  const voltageA = isSimulating ? simGunA.voltage : tel1?.voltage ? Math.round(Number(tel1.voltage)) : (tel1?.voltageL1 ? Math.round(Number(tel1.voltageL1)) : 0);
  const currentA = isSimulating ? simGunA.current : Number(tel1?.currentL1 || 0);
  const socA = isSimulating ? (simGunA.soc > 0 ? simGunA.soc : null) : (typeof tel1?.soc === 'number' && tel1.soc > 0 ? tel1.soc : null);

  // Helpers to safely resolve Gun A / Gun B active transactions
  const isTxForGunA = (tx: any) => tx && (Number(tx.connectorId || tx.connector_id) === 1 || (!tx.connectorId && !tx.connector_id));
  const isTxForGunB = (tx: any) => tx && Number(tx.connectorId || tx.connector_id) === 2;

  // Session energy delivered for Gun A - anchored to authoritative server values
  const txA = activeTx1Data || connector1Data?.activeTx || (isTxForGunA(activeTxData) ? activeTxData : null);
  const serverCostA = Number(txA?.cost) || (isTxForGunA(activeTxData) ? Number(activeTxData?.cost) : 0) || 0;
  const serverEnergyA = Number(txA?.energyDeliveredKwh) || (txA?.energyDeliveredWh ? Number((txA.energyDeliveredWh / 1000).toFixed(2)) : 0) || (isTxForGunA(activeTxData) ? (Number(activeTxData?.energyDeliveredKwh) || (Number(activeTxData?.energyDeliveredWh) / 1000) || 0) : 0);
  const deliveredA = serverEnergyA > 0 ? serverEnergyA : (txA?.energyDeliveredWh ? Number((txA.energyDeliveredWh / 1000).toFixed(2)) : 0);
  const mStartA = txA?.meterStart !== undefined && txA?.meterStart !== null && Number(txA.meterStart) > 0 ? Number(txA.meterStart) : null;
  const currentEnergyWhA = tel1?.energyWh || (tel1?.energyKwh ? Math.round(Number(tel1.energyKwh) * 1000) : null);
  const computedA =
    mStartA !== null && currentEnergyWhA !== null && currentEnergyWhA >= mStartA
      ? Math.max(0, (currentEnergyWhA - mStartA) / 1000)
      : 0;
  const baseEnergyA = Math.max(serverEnergyA, computedA, deliveredA);
  const sessionEnergyA = isSimulating ? simGunA.energyKwh : baseEnergyA + liveAccumulatedA;
  const lifetimeMeterA = tel1?.energyKwh || (tel1?.energyWh ? (tel1.energyWh / 1000).toFixed(2) : '0.00');
  const energyA = isOnline
    ? (isSimulating ? simGunA.energyKwh.toFixed(2) : sessionEnergyA.toFixed(2))
    : '0.00';

  // Telemetry for Gun B (Connector 2) - directly from live OCPP server or simulator
  const tel2 = isOnline ? connector2Data?.telemetry : null;
  const powerB = isOnline && !is30kW ? (isSimulating ? simGunB.powerKw : Number(tel2?.powerKw || 0)) : 0;
  const voltageB = isOnline && !is30kW ? (isSimulating ? simGunB.voltage : tel2?.voltage ? Math.round(Number(tel2.voltage)) : (tel2?.voltageL1 ? Math.round(Number(tel2.voltageL1)) : 0)) : 0;
  const currentB = isOnline && !is30kW ? (isSimulating ? simGunB.current : Number(tel2?.currentL1 || 0)) : 0;
  const socB = isOnline && !is30kW ? (isSimulating ? (simGunB.soc > 0 ? simGunB.soc : null) : (typeof tel2?.soc === 'number' && tel2.soc > 0 ? tel2.soc : null)) : null;

  // Session energy delivered for Gun B - anchored to authoritative server values
  const txB = activeTx2Data || connector2Data?.activeTx || (isTxForGunB(activeTxData) ? activeTxData : null);
  const serverCostB = Number(txB?.cost) || (isTxForGunB(activeTxData) ? Number(activeTxData?.cost) : 0) || 0;
  const serverEnergyB = Number(txB?.energyDeliveredKwh) || (txB?.energyDeliveredWh ? Number((txB.energyDeliveredWh / 1000).toFixed(2)) : 0) || (isTxForGunB(activeTxData) ? (Number(activeTxData?.energyDeliveredKwh) || (Number(activeTxData?.energyDeliveredWh) / 1000) || 0) : 0);
  const deliveredB = serverEnergyB > 0 ? serverEnergyB : (txB?.energyDeliveredWh ? Number((txB.energyDeliveredWh / 1000).toFixed(2)) : 0);
  const mStartB = txB?.meterStart !== undefined && txB?.meterStart !== null && Number(txB.meterStart) > 0 ? Number(txB.meterStart) : null;
  const currentEnergyWhB = tel2?.energyWh || (tel2?.energyKwh ? Math.round(Number(tel2.energyKwh) * 1000) : null);
  const computedB =
    mStartB !== null && currentEnergyWhB !== null && currentEnergyWhB >= mStartB
      ? Math.max(0, (currentEnergyWhB - mStartB) / 1000)
      : 0;
  const baseEnergyB = Math.max(serverEnergyB, computedB, deliveredB);
  const sessionEnergyB = isSimulating ? simGunB.energyKwh : baseEnergyB + liveAccumulatedB;
  const lifetimeMeterB = tel2?.energyKwh || (tel2?.energyWh ? (tel2.energyWh / 1000).toFixed(2) : '0.00');
  const energyB = isOnline
    ? (isSimulating ? simGunB.energyKwh.toFixed(2) : sessionEnergyB.toFixed(2))
    : '0.00';

  // Total Power
  const totalPower = is30kW ? Number(powerA).toFixed(1) : (powerA + powerB).toFixed(1);

  // Real-time Cost Calculation using Tariff Rate (anchored to server-provided session cost)
  const rate = chargerData?.tariffRate && Number(chargerData.tariffRate) > 0
    ? Number(chargerData.tariffRate)
    : tariffRate && tariffRate > 0
    ? tariffRate
    : 125;
  const curr = 'PKR';
  const calcCostA = Math.round(sessionEnergyA * rate);
  const baseCostA = Math.max(serverCostA, calcCostA);
  const costA = isSimulating
    ? Math.round(simGunA.cost).toString()
    : (baseCostA > 0
        ? Math.round(baseCostA + (liveAccumulatedA * rate)).toString()
        : calcCostA.toString());

  const calcCostB = Math.round(sessionEnergyB * rate);
  const baseCostB = Math.max(serverCostB, calcCostB);
  const costB = isSimulating
    ? Math.round(simGunB.cost).toString()
    : (baseCostB > 0
        ? Math.round(baseCostB + (liveAccumulatedB * rate)).toString()
        : calcCostB.toString());

  const totalEnergy = is30kW
    ? energyA
    : (sessionEnergyA + sessionEnergyB).toFixed(2);
  const totalCost = isSimulating
    ? Math.round(simGunA.cost + simGunB.cost).toLocaleString()
    : Math.round(Number(totalEnergy) * rate).toLocaleString();
  const hasAnyGunConnected = is30kW ? isGunAConnected : isGunAConnected || isGunBConnected;

  // Last completed session metrics for standby presentation
  const lastSessionKwh =
    Number(lastCompletedTx?.energyDeliveredKwh) ||
    (Number(lastCompletedTx?.energyDeliveredWh) ? Number(lastCompletedTx.energyDeliveredWh) / 1000 : 0);
  const lastSessionRate =
    Number(lastCompletedTx?.tariffRate) ||
    (chargerData?.tariffRate && Number(chargerData.tariffRate) > 0 ? Number(chargerData.tariffRate) : 125);
  const lastSessionCost =
    Number(lastCompletedTx?.cost) > 0
      ? Math.round(Number(lastCompletedTx.cost))
      : Math.round(lastSessionKwh * lastSessionRate);

  const lastDiffMs =
    lastCompletedTx?.startTime && lastCompletedTx?.stopTime
      ? new Date(lastCompletedTx.stopTime).getTime() - new Date(lastCompletedTx.startTime).getTime()
      : 0;
  const lastDurationMin = lastDiffMs > 0 ? Math.max(1, Math.round(lastDiffMs / 60000)) : null;
  const lastDurationText = lastDurationMin !== null ? `${lastDurationMin} min` : null;

  // Real-time 1-second auto-interpolator: ticks energy & cost live second-by-second while car is charging
  useEffect(() => {
    const isChargingA = isOnline && isGunAConnected && status1 === 'Charging' && powerA > 0;
    const isChargingB = isOnline && !is30kW && isGunBConnected && status2 === 'Charging' && powerB > 0;

    if (!isChargingA && !isChargingB) {
      setLiveAccumulatedA(0);
      setLiveAccumulatedB(0);
      return;
    }

    const timer = setInterval(() => {
      if (isChargingA) {
        setLiveAccumulatedA((prev) => prev + (powerA / 3600));
      }
      if (isChargingB) {
        setLiveAccumulatedB((prev) => prev + (powerB / 3600));
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [isOnline, isGunAConnected, isGunBConnected, status1, status2, powerA, powerB, is30kW]);

  // Re-anchor accumulators whenever fresh physical meter values arrive from hardware
  useEffect(() => {
    setLiveAccumulatedA(0);
  }, [tel1?.energyWh, tel1?.energyKwh]);

  useEffect(() => {
    setLiveAccumulatedB(0);
  }, [tel2?.energyWh, tel2?.energyKwh]);

  // Active Battery State of Charge (SoC %) - safely converted to number from hardware/server
  const rawSocA = isSimulating
    ? simGunA.soc
    : (Number(tel1?.soc) > 0
        ? Number(tel1.soc)
        : Number(txA?.socCurrent) > 0
        ? Number(txA.socCurrent)
        : Number(txA?.soc) > 0
        ? Number(txA.soc)
        : (isTxForGunA(activeTxData) && Number(activeTxData?.socCurrent) > 0)
        ? Number(activeTxData.socCurrent)
        : (isTxForGunA(activeTxData) && Number(activeTxData?.soc) > 0)
        ? Number(activeTxData.soc)
        : null);
  const activeSocA = (typeof rawSocA === 'number' && rawSocA > 0 && rawSocA <= 100) ? Math.round(rawSocA) : null;

  const rawSocB = isSimulating
    ? simGunB.soc
    : (Number(tel2?.soc) > 0
        ? Number(tel2.soc)
        : Number(txB?.socCurrent) > 0
        ? Number(txB.socCurrent)
        : Number(txB?.soc) > 0
        ? Number(txB.soc)
        : (isTxForGunB(activeTxData) && Number(activeTxData?.socCurrent) > 0)
        ? Number(activeTxData.socCurrent)
        : (isTxForGunB(activeTxData) && Number(activeTxData?.soc) > 0)
        ? Number(activeTxData.soc)
        : null);
  const activeSocB = (typeof rawSocB === 'number' && rawSocB > 0 && rawSocB <= 100) ? Math.round(rawSocB) : null;

  // Gun charging detection
  const isGunACharging = isOnline && status1 === 'Charging';
  const isGunBCharging = isOnline && !is30kW && status2 === 'Charging';
  const bothCharging = isGunACharging && isGunBCharging;
  const isActivelyChargingNow = isGunACharging || isGunBCharging;

  // Attached car detection (Only active when charger is online)
  const isCarAAttached =
    isOnline &&
    (isGunAConnected ||
      Number(powerA) > 0 ||
      status1 === 'Charging' ||
      status1 === 'Preparing' ||
      Boolean(txA));

  const isCarBAttached =
    isOnline &&
    !is30kW &&
    (isGunBConnected ||
      Number(powerB) > 0 ||
      status2 === 'Charging' ||
      status2 === 'Preparing' ||
      Boolean(txB));

  const bothCarsAttached = isOnline && isCarAAttached && isCarBAttached;
  const onlyCarAAttached = isOnline && isCarAAttached && !isCarBAttached;
  const onlyCarBAttached = isOnline && isCarBAttached && !isCarAAttached;

  const hasSocA = typeof activeSocA === 'number' && activeSocA > 0;
  const hasSocB = typeof activeSocB === 'number' && activeSocB > 0;
  const showDualBattery = !is30kW && (
    (isGunAConnected && isGunBConnected && (hasSocA || hasSocB)) ||
    bothCharging
  );

  // Single gun fallback: strictly align with the actively charging gun (never mismatch Gun A and Gun B)
  const singleGunIsB = isGunBCharging || (!isGunACharging && !isGunAConnected && isGunBConnected);
  const displaySoc = singleGunIsB ? (hasSocB ? activeSocB : null) : (hasSocA ? activeSocA : (hasSocB ? activeSocB : null));
  const displaySocGunLabel = singleGunIsB ? 'GUN B' : 'GUN A';

  if (authLoading) {
    return <DashboardSkeleton isSingleGun={is30kW} />;
  }

  if (!isAuthenticated) {
    return <Redirect href="/login" />;
  }

  if (!isConfigured || !CHARGER_ID) {
    return <Redirect href="/setup" />;
  }

  if (isIdentifying) {
    return <DashboardSkeleton isSingleGun={is30kW} />;
  }

  return (
    <SwipeableTabScreen currentTab="index">
      <View style={styles.container}>
        {/* Header: Station ID & Test UI */}
        <View style={styles.header}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Image
              source={require('@/assets/images/brand-logo.png')}
              style={styles.headerLogo}
              resizeMode="contain"
            />
            <Text style={styles.stationId}>{CHARGER_ID.toUpperCase()}</Text>
          </View>

          <TouchableOpacity
            style={styles.testUiBtn}
            onPress={() => setSimModalVisible(true)}
            activeOpacity={0.8}
          >
            <Text style={styles.testUiBtnText}>🧪 Test UI</Text>
          </TouchableOpacity>
        </View>

        {/* Hero Charger Graphic (Fills upper space dynamically) */}
        <View style={styles.heroChargerContainer}>
          <Image source={safeHeroImage} style={styles.heroChargerImage} resizeMode="contain" />
        </View>

        {/* Unified Bottom Charging Dashboard (Seamless, No Disjointed Divs, No Empty Space) */}
        <View style={styles.bottomDashboard}>
          {!isOnline ? (
            /* STATION IS OFFLINE - Explicit Clean Offline Presentation */
            <View style={styles.unifiedStandbyDashboard}>
              <View style={[styles.standbyBadge, { backgroundColor: '#FEF2F2' }]}>
                <View style={[styles.gunDot, { backgroundColor: '#EF4444', width: 6.5, height: 6.5 }]} />
                <Text style={[styles.standbyBadgeText, { color: '#DC2626' }]}>CHARGER OFFLINE</Text>
              </View>

              <View style={styles.unifiedPriceRow}>
                <Text style={[styles.unifiedPriceVal, { color: '#64748B' }]}>OFFLINE</Text>
              </View>

              <Text style={styles.unifiedSpeedSub}>
                {isServerReachable === false
                  ? 'Connecting to OCPP server...'
                  : 'Charger is disconnected from network'}
              </Text>
            </View>
          ) : bothCarsAttached ? (
            /* BOTH Cars Attached: Symmetrical Dual Telemetry View (Non-wrapping & Perfectly Aligned) */
            <View style={styles.unifiedDualDashboard}>
              <View style={styles.dualColumnsRow}>
                {/* Gun A Column */}
                <View style={styles.dualCol}>
                  <View style={[styles.dualStatusBadge, { backgroundColor: themeA.bg }]}>
                    <View style={[styles.gunDot, { backgroundColor: themeA.color, width: 6.5, height: 6.5 }]} />
                    <Text
                      style={[styles.dualStatusText, { color: themeA.color }]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.8}
                    >
                      GUN A • {getDualStatusLabel(themeA.label)}
                    </Text>
                  </View>
                  <View style={styles.dualPriceRow}>
                    <AnimatedMetricValue style={styles.dualPriceHeroVal} value={Number(costA).toLocaleString()} />
                    <Text style={styles.dualPriceHeroCurr}>{curr}</Text>
                  </View>
                  <View style={styles.dualSubRow}>
                    <Text style={styles.dualPriceHeroSub} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
                      {Number(powerA).toFixed(1)} kW {hasSocA ? `• ${activeSocA}% SoC` : ''}
                    </Text>
                  </View>
                  <View style={styles.dualTelemetryStrip}>
                    <View style={styles.dualTelemetryItem}>
                      <Text style={styles.dualTelemetryVal} numberOfLines={1}>{energyA}</Text>
                      <Text style={styles.dualTelemetryUnit}>kWh</Text>
                    </View>
                    <View style={styles.dualTelemetryDivider} />
                    <View style={styles.dualTelemetryItem}>
                      <Text style={styles.dualTelemetryVal} numberOfLines={1}>
                        {Number(currentA).toFixed(Number(currentA) >= 100 ? 0 : 1)}
                      </Text>
                      <Text style={styles.dualTelemetryUnit}>A</Text>
                    </View>
                    <View style={styles.dualTelemetryDivider} />
                    <View style={styles.dualTelemetryItem}>
                      <Text style={styles.dualTelemetryVal} numberOfLines={1}>{voltageA}</Text>
                      <Text style={styles.dualTelemetryUnit}>V</Text>
                    </View>
                  </View>
                </View>

                {/* Elegant subtle vertical divider */}
                <View style={styles.dualDivider} />

                {/* Gun B Column */}
                <View style={styles.dualCol}>
                  <View style={[styles.dualStatusBadge, { backgroundColor: themeB.bg }]}>
                    <View style={[styles.gunDot, { backgroundColor: themeB.color, width: 6.5, height: 6.5 }]} />
                    <Text
                      style={[styles.dualStatusText, { color: themeB.color }]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.8}
                    >
                      GUN B • {getDualStatusLabel(themeB.label)}
                    </Text>
                  </View>
                  <View style={styles.dualPriceRow}>
                    <AnimatedMetricValue style={styles.dualPriceHeroVal} value={Number(costB).toLocaleString()} />
                    <Text style={styles.dualPriceHeroCurr}>{curr}</Text>
                  </View>
                  <View style={styles.dualSubRow}>
                    <Text style={styles.dualPriceHeroSub} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
                      {Number(powerB).toFixed(1)} kW {hasSocB ? `• ${activeSocB}% SoC` : ''}
                    </Text>
                  </View>
                  <View style={styles.dualTelemetryStrip}>
                    <View style={styles.dualTelemetryItem}>
                      <Text style={styles.dualTelemetryVal} numberOfLines={1}>{energyB}</Text>
                      <Text style={styles.dualTelemetryUnit}>kWh</Text>
                    </View>
                    <View style={styles.dualTelemetryDivider} />
                    <View style={styles.dualTelemetryItem}>
                      <Text style={styles.dualTelemetryVal} numberOfLines={1}>
                        {Number(currentB).toFixed(Number(currentB) >= 100 ? 0 : 1)}
                      </Text>
                      <Text style={styles.dualTelemetryUnit}>A</Text>
                    </View>
                    <View style={styles.dualTelemetryDivider} />
                    <View style={styles.dualTelemetryItem}>
                      <Text style={styles.dualTelemetryVal} numberOfLines={1}>{voltageB}</Text>
                      <Text style={styles.dualTelemetryUnit}>V</Text>
                    </View>
                  </View>
                </View>
              </View>
              <Text style={styles.dualTotalSpeedSubtext}>
                Combined Speed: {totalPower} kW • Total: {totalCost} PKR
              </Text>
            </View>
          ) : onlyCarBAttached ? (
            /* ONLY Car B Attached: Unified Single Presentation without standing-out div */
            <View style={styles.unifiedSingleDashboard}>
              <View style={styles.unifiedStatusRow}>
                <View style={[styles.unifiedStatusBadge, { backgroundColor: themeB.bg }]}>
                  <View style={[styles.gunDot, { backgroundColor: themeB.color, width: 7, height: 7 }]} />
                  <Text style={[styles.unifiedStatusText, { color: themeB.color }]}>GUN B • {themeB.label.toUpperCase()}</Text>
                </View>
                {hasSocB ? (
                  <View style={styles.unifiedSocBadge}>
                    <Text style={styles.unifiedSocText}>{activeSocB}% SoC</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.unifiedPriceRow}>
                <AnimatedMetricValue style={styles.unifiedPriceVal} value={Number(costB).toLocaleString()} />
                <Text style={styles.unifiedPriceCurr}>{curr}</Text>
              </View>

              <Text style={styles.unifiedSpeedSub}>
                {Number(powerB) > 0 ? `Charging at ${Number(powerB).toFixed(1)} kW` : 'Connected • Preparing'}
              </Text>

              <View style={styles.unifiedMetricsRow}>
                <View style={styles.unifiedMetricItem}>
                  <Text style={styles.unifiedMetricLabel}>ENERGY</Text>
                  <Text style={styles.unifiedMetricVal}>{energyB} <Text style={styles.unifiedMetricUnit}>kWh</Text></Text>
                </View>
                <View style={styles.unifiedMetricDivider} />
                <View style={styles.unifiedMetricItem}>
                  <Text style={styles.unifiedMetricLabel}>CURRENT</Text>
                  <Text style={styles.unifiedMetricVal}>{currentB} <Text style={styles.unifiedMetricUnit}>A</Text></Text>
                </View>
                <View style={styles.unifiedMetricDivider} />
                <View style={styles.unifiedMetricItem}>
                  <Text style={styles.unifiedMetricLabel}>VOLTAGE</Text>
                  <Text style={styles.unifiedMetricVal}>{voltageB} <Text style={styles.unifiedMetricUnit}>V</Text></Text>
                </View>
              </View>
            </View>
          ) : onlyCarAAttached ? (
            /* ONLY Car A Attached: Unified Single Presentation without standing-out div */
            <View style={styles.unifiedSingleDashboard}>
              <View style={styles.unifiedStatusRow}>
                <View style={[styles.unifiedStatusBadge, { backgroundColor: themeA.bg }]}>
                  <View style={[styles.gunDot, { backgroundColor: themeA.color, width: 7, height: 7 }]} />
                  <Text style={[styles.unifiedStatusText, { color: themeA.color }]}>
                    GUN A {is30kW ? '(30kW)' : ''} • {themeA.label.toUpperCase()}
                  </Text>
                </View>
                {hasSocA ? (
                  <View style={styles.unifiedSocBadge}>
                    <Text style={styles.unifiedSocText}>{activeSocA}% SoC</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.unifiedPriceRow}>
                <AnimatedMetricValue style={styles.unifiedPriceVal} value={Number(costA).toLocaleString()} />
                <Text style={styles.unifiedPriceCurr}>{curr}</Text>
              </View>

              <Text style={styles.unifiedSpeedSub}>
                {Number(powerA) > 0 ? `Charging at ${Number(powerA).toFixed(1)} kW` : 'Connected • Preparing'}
              </Text>

              <View style={styles.unifiedMetricsRow}>
                <View style={styles.unifiedMetricItem}>
                  <Text style={styles.unifiedMetricLabel}>ENERGY</Text>
                  <Text style={styles.unifiedMetricVal}>{energyA} <Text style={styles.unifiedMetricUnit}>kWh</Text></Text>
                </View>
                <View style={styles.unifiedMetricDivider} />
                <View style={styles.unifiedMetricItem}>
                  <Text style={styles.unifiedMetricLabel}>CURRENT</Text>
                  <Text style={styles.unifiedMetricVal}>{currentA} <Text style={styles.unifiedMetricUnit}>A</Text></Text>
                </View>
                <View style={styles.unifiedMetricDivider} />
                <View style={styles.unifiedMetricItem}>
                  <Text style={styles.unifiedMetricLabel}>VOLTAGE</Text>
                  <Text style={styles.unifiedMetricVal}>{voltageA} <Text style={styles.unifiedMetricUnit}>V</Text></Text>
                </View>
              </View>
            </View>
          ) : (
            /* NEITHER Car Attached: Clean Standby / Idle Mode */
            <View style={styles.unifiedStandbyDashboard}>
              <View style={styles.standbyPillsRow}>
                <View style={styles.standbyBadge}>
                  <View style={[styles.gunDot, { backgroundColor: '#10B981', width: 6.5, height: 6.5 }]} />
                  <Text style={styles.standbyBadgeText}>GUN A • AVAILABLE</Text>
                </View>
                {!is30kW ? (
                  <View style={styles.standbyBadge}>
                    <View style={[styles.gunDot, { backgroundColor: '#10B981', width: 6.5, height: 6.5 }]} />
                    <Text style={styles.standbyBadgeText}>GUN B • AVAILABLE</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.unifiedPriceRow}>
                <Text style={styles.unifiedPriceVal}>
                  {lastSessionCost > 0 ? Number(lastSessionCost).toLocaleString() : 'READY'}
                </Text>
                <Text style={styles.unifiedPriceCurr}>
                  {lastSessionCost > 0 ? curr : ''}
                </Text>
              </View>

              <Text style={styles.unifiedSpeedSub}>
                {lastSessionCost > 0
                  ? `Last Session • ${lastSessionKwh.toFixed(1)} kWh ${lastDurationText ? `• ${lastDurationText}` : ''}`
                  : 'Plug charging cable into vehicle to begin'}
              </Text>
            </View>
          )}
        </View>

        {/* UI Test Simulator Modal for Testing without physical cars */}
        <SimulatorModal visible={simModalVisible} onClose={() => setSimModalVisible(false)} />
      </View>
    </SwipeableTabScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 46 : 28,
    paddingBottom: Platform.OS === 'ios' ? 100 : 86,
    justifyContent: 'space-between',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  testUiBtn: {
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  testUiBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0F172A',
  },
  headerLogo: {
    width: 28,
    height: 28,
  },
  stationId: {
    fontSize: 18,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: 0.8,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },

  /* Hero Charger Image - dynamically centers and scales within flexible space */
  heroChargerContainer: {
    width: '100%',
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 6,
  },
  heroChargerImage: {
    width: '100%',
    height: '100%',
    maxHeight: 290,
    maxWidth: 420,
  },

  /* Unified Bottom Charging Dashboard */
  bottomDashboard: {
    width: '100%',
    alignItems: 'center',
    paddingBottom: 4,
  },

  /* Single Gun Unified Presentation */
  unifiedSingleDashboard: {
    width: '100%',
    alignItems: 'center',
  },
  unifiedStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 6,
  },
  unifiedStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    paddingVertical: 4.5,
    borderRadius: 20,
    gap: 6,
  },
  unifiedStatusText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  unifiedSocBadge: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 11,
    paddingVertical: 4.5,
    borderRadius: 20,
  },
  unifiedSocText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#0F172A',
  },
  unifiedPriceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: 6,
    marginTop: 2,
  },
  unifiedPriceVal: {
    fontSize: 48,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -1.5,
    fontVariant: ['tabular-nums'],
  },
  unifiedPriceCurr: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0284C7',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  unifiedSpeedSub: {
    fontSize: 13.5,
    fontWeight: '700',
    color: '#64748B',
    marginTop: 2,
    marginBottom: 10,
    textAlign: 'center',
  },
  unifiedMetricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    backgroundColor: '#F8FAFC',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  unifiedMetricItem: {
    flex: 1,
    alignItems: 'center',
  },
  unifiedMetricDivider: {
    width: 1,
    height: 22,
    backgroundColor: '#E2E8F0',
  },
  unifiedMetricLabel: {
    fontSize: 9.5,
    fontWeight: '800',
    color: '#94A3B8',
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  unifiedMetricVal: {
    fontSize: 14,
    fontWeight: '900',
    color: '#0F172A',
    fontVariant: ['tabular-nums'],
  },
  unifiedMetricUnit: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#64748B',
  },

  /* Dual Gun Unified Presentation */
  unifiedDualDashboard: {
    width: '100%',
    alignItems: 'center',
  },
  dualColumnsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'space-between',
    width: '100%',
    paddingVertical: 2,
    paddingHorizontal: 2,
  },
  dualCol: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 3,
  },
  dualDivider: {
    width: 1,
    backgroundColor: '#E2E8F0',
    marginHorizontal: 4,
    alignSelf: 'stretch',
  },
  dualStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 20,
    height: 25,
    gap: 5,
    maxWidth: '96%',
    alignSelf: 'center',
    marginBottom: 6,
  },
  dualStatusText: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  dualPriceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: 4,
    height: 34,
  },
  dualPriceHeroVal: {
    fontSize: 28,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -0.8,
    fontVariant: ['tabular-nums'],
  },
  dualPriceHeroCurr: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0284C7',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  dualSubRow: {
    height: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 2,
    marginBottom: 8,
  },
  dualPriceHeroSub: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#475569',
    textAlign: 'center',
  },
  dualTelemetryStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    paddingVertical: 6,
    paddingHorizontal: 2,
    height: 42,
  },
  dualTelemetryItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dualTelemetryVal: {
    fontSize: 11.5,
    fontWeight: '900',
    color: '#0F172A',
    fontVariant: ['tabular-nums'],
  },
  dualTelemetryUnit: {
    fontSize: 8.5,
    fontWeight: '700',
    color: '#64748B',
    marginTop: 1,
    textTransform: 'uppercase',
  },
  dualTelemetryDivider: {
    width: 1,
    height: 18,
    backgroundColor: '#E2E8F0',
  },
  dualTotalSpeedSubtext: {
    fontSize: 11.5,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 8,
    textAlign: 'center',
  },

  /* Standby Presentation */
  unifiedStandbyDashboard: {
    width: '100%',
    alignItems: 'center',
  },
  standbyPillsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  standbyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#ECFDF5',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
  },
  standbyBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#059669',
    letterSpacing: 0.5,
  },
  gunDot: {
    width: 6.5,
    height: 6.5,
    borderRadius: 3.25,
  },
});
