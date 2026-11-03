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
      border: 'rgba(100, 116, 139, 0.15)',
    }
  );
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

  // Track true server connectivity and charger online status
  const isOnline = isSimulating || (
    isServerReachable !== false &&
    (isWebSocketConnected ||
      chargerData?.status === 'Online' ||
      isActivelyEngaged ||
      (connector1Data && connector1Data.status !== 'Unavailable') ||
      (connector2Data && connector2Data.status !== 'Unavailable'))
  );

  const status1 = isOnline || isGunAPlugged ? rawStatus1 : 'Unavailable';
  const status2 = (isOnline || isGunBPlugged) && !is30kW ? rawStatus2 : 'Unavailable';

  const isGunAConnected = isGunAPlugged;
  const isGunBConnected = isGunBPlugged;
  const bothConnected = !is30kW && isGunAConnected && isGunBConnected;

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
  if (is30kW) {
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
  const energyA = isSimulating ? simGunA.energyKwh.toFixed(2) : sessionEnergyA.toFixed(2);

  // Telemetry for Gun B (Connector 2) - directly from live OCPP server or simulator
  const tel2 = connector2Data?.telemetry;
  const powerB = isSimulating ? simGunB.powerKw : Number(tel2?.powerKw || 0);
  const voltageB = isSimulating ? simGunB.voltage : tel2?.voltage ? Math.round(Number(tel2.voltage)) : (tel2?.voltageL1 ? Math.round(Number(tel2.voltageL1)) : 0);
  const currentB = isSimulating ? simGunB.current : Number(tel2?.currentL1 || 0);
  const socB = isSimulating ? (simGunB.soc > 0 ? simGunB.soc : null) : (typeof tel2?.soc === 'number' && tel2.soc > 0 ? tel2.soc : null);

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
  const energyB = isSimulating ? simGunB.energyKwh.toFixed(2) : sessionEnergyB.toFixed(2);

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

        {/* Hero Charger Graphic (Auto-scaled to fit screen) */}
        <View style={styles.heroChargerContainer}>
          <Image source={safeHeroImage} style={styles.heroChargerImage} resizeMode="contain" />
        </View>

        {/* Primary Live Status / Price Hero Section */}
        <View style={styles.powerSection}>
          {isGunACharging && isGunBCharging ? (
            <View style={styles.priceHeroColumn}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                <AnimatedMetricValue style={styles.priceHeroVal} value={totalCost} />
                <Text style={styles.priceHeroCurr}>{curr}</Text>
              </View>
              <Text style={styles.powerSubtext}>
                Total Speed: {totalPower} kW • Both Guns Charging
              </Text>
            </View>
          ) : isGunACharging ? (
            <View style={styles.priceHeroColumn}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                <AnimatedMetricValue style={styles.priceHeroVal} value={costA} />
                <Text style={styles.priceHeroCurr}>{curr}</Text>
              </View>
              <Text style={styles.powerSubtext}>
                Gun A • Speed: {Number(powerA).toFixed(1)} kW {hasSocA ? `• ${activeSocA}% SoC` : ''}
              </Text>
            </View>
          ) : isGunBCharging ? (
            <View style={styles.priceHeroColumn}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                <AnimatedMetricValue style={styles.priceHeroVal} value={costB} />
                <Text style={styles.priceHeroCurr}>{curr}</Text>
              </View>
              <Text style={styles.powerSubtext}>
                Gun B • Speed: {Number(powerB).toFixed(1)} kW {hasSocB ? `• ${activeSocB}% SoC` : ''}
              </Text>
            </View>
          ) : hasAnyGunConnected ? (
            <View style={styles.priceHeroColumn}>
              <AnimatedMetricValue
                style={styles.priceHeroVal}
                value={Number(totalCost.replace(/,/g, '')) > 0 ? totalCost : 'READY'}
              />
              <Text style={styles.priceHeroCurr}>
                {Number(totalCost.replace(/,/g, '')) > 0 ? `${curr} (session)` : 'PLUGGED IN • READY TO CHARGE'}
              </Text>
            </View>
          ) : !isOnline ? (
            <View style={styles.priceHeroColumn}>
              <Text style={styles.priceHeroVal}>OFFLINE</Text>
              <Text style={styles.priceHeroCurr}>
                {isServerReachable === false ? 'CONNECTING TO SERVER...' : 'STATION STANDBY'}
              </Text>
            </View>
          ) : lastSessionCost > 0 ? (
            <View style={styles.priceHeroColumn}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                <AnimatedMetricValue style={styles.priceHeroVal} value={lastSessionCost.toLocaleString()} />
                <Text style={styles.priceHeroCurr}>{curr}</Text>
              </View>
              <Text style={styles.powerSubtext}>
                Last Session • {lastSessionKwh.toFixed(1)} kWh {lastDurationText ? `• ${lastDurationText}` : ''}
              </Text>
            </View>
          ) : (
            <View style={styles.priceHeroColumn}>
              <Text style={styles.priceHeroVal}>STANDBY</Text>
              <Text style={styles.priceHeroCurr}>READY TO CONNECT</Text>
            </View>
          )}
        </View>

        {/* Gun Status Section: Gun A & Gun B Cards (or Single Gun for 30kW) */}
        {is30kW ? (
          <View style={styles.singleContainer}>
            <View style={styles.singleGunHeader}>
              <View style={[styles.gunDot, { backgroundColor: themeA.color }]} />
              <Text style={styles.gunTitle}>GUN 1 (30kW)</Text>
              <View style={[styles.miniStatusPill, { backgroundColor: themeA.bg, marginLeft: 8 }]}>
                <Text style={[styles.miniStatusText, { color: themeA.color }]}>{themeA.label}</Text>
              </View>
              {tel1?.soc != null && tel1?.soc !== '' ? (
                <View style={{ marginLeft: 'auto', backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#0F172A' }}>{tel1.soc}% SoC</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.metricsGrid}>
              <View style={styles.metricItem}>
                <Text style={styles.metricLabel}>POWER</Text>
                <Text style={styles.metricValue}>{Number(powerA).toFixed(1)} kW</Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.metricItem}>
                <Text style={styles.metricLabel}>ENERGY</Text>
                <Text style={styles.metricValue}>{energyA} kWh</Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.metricItem}>
                <Text style={styles.metricLabel}>CURRENT</Text>
                <Text style={styles.metricValue}>{currentA} A</Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.metricItem}>
                <Text style={styles.metricLabel}>VOLTAGE</Text>
                <Text style={styles.metricValue}>{voltageA} V</Text>
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.dualContainer}>
            {/* Gun A Card */}
            <View style={styles.gunCard}>
              <View style={styles.gunHeader}>
                <View style={styles.gunTitleRow}>
                  <View style={[styles.gunDot, { backgroundColor: themeA.color }]} />
                  <Text style={styles.gunTitle}>GUN A</Text>
                </View>
                <View style={[styles.miniStatusPill, { backgroundColor: themeA.bg }]}>
                  <Text style={[styles.miniStatusText, { color: themeA.color }]}>{themeA.label}</Text>
                </View>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6, marginTop: 2 }}>
                <AnimatedMetricValue style={styles.gunPower} value={`${Number(powerA).toFixed(1)} kW`} />
                {hasSocA ? (
                  <View style={{ backgroundColor: '#F1F5F9', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#0F172A' }}>{activeSocA}% SoC</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.gunMetricRow}>
                <Text style={styles.gunMetricLabel}>Voltage / Current</Text>
                <Text style={styles.gunMetricVal}>{voltageA}V • {currentA}A</Text>
              </View>
              <View style={styles.gunMetricRow}>
                <Text style={styles.gunMetricLabel}>Session Energy</Text>
                <Text style={styles.gunMetricVal}>{energyA} kWh</Text>
              </View>
            </View>

            {/* Gun B Card */}
            <View style={styles.gunCard}>
              <View style={styles.gunHeader}>
                <View style={styles.gunTitleRow}>
                  <View style={[styles.gunDot, { backgroundColor: themeB.color }]} />
                  <Text style={styles.gunTitle}>GUN B</Text>
                </View>
                <View style={[styles.miniStatusPill, { backgroundColor: themeB.bg }]}>
                  <Text style={[styles.miniStatusText, { color: themeB.color }]}>{themeB.label}</Text>
                </View>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6, marginTop: 2 }}>
                <AnimatedMetricValue style={styles.gunPower} value={`${Number(powerB).toFixed(1)} kW`} />
                {hasSocB ? (
                  <View style={{ backgroundColor: '#F1F5F9', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#0F172A' }}>{activeSocB}% SoC</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.gunMetricRow}>
                <Text style={styles.gunMetricLabel}>Voltage / Current</Text>
                <Text style={styles.gunMetricVal}>{voltageB}V • {currentB}A</Text>
              </View>
              <View style={styles.gunMetricRow}>
                <Text style={styles.gunMetricLabel}>Session Energy</Text>
                <Text style={styles.gunMetricVal}>{energyB} kWh</Text>
              </View>
            </View>
          </View>
        )}

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
    paddingTop: Platform.OS === 'ios' ? 48 : 32,
    paddingBottom: Platform.OS === 'ios' ? 105 : 90,
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

  /* Hero Charger Image - dynamically scales within available space */
  heroChargerContainer: {
    width: '100%',
    flex: 1,
    maxHeight: 180,
    minHeight: 110,
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 2,
  },
  heroChargerImage: {
    width: '100%',
    height: '100%',
    maxWidth: 380,
  },

  /* Power Section & Hero Price */
  powerSection: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 4,
  },
  priceHeroColumn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  priceHeroVal: {
    fontSize: 36,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  priceHeroCurr: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0284C7',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  powerSubtext: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 2,
  },
  powerRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
  },
  powerValue: {
    fontSize: 44,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -1.5,
  },
  powerUnit: {
    fontSize: 16,
    fontWeight: '800',
    color: '#64748B',
    marginLeft: 6,
  },

  /* Dual Gun Layout */
  dualContainer: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 2,
  },
  gunCard: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#F8FAFC',
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    borderRadius: 14,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  gunHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  gunTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  gunDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  gunTitle: {
    fontSize: 12,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: 0.5,
  },
  miniStatusPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  miniStatusText: {
    fontSize: 9,
    fontWeight: '800',
  },
  gunPower: {
    fontSize: 18,
    fontWeight: '900',
    color: '#0F172A',
  },
  gunMetricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  gunMetricLabel: {
    fontSize: 11,
    color: '#475569',
    fontWeight: '700',
  },
  gunMetricVal: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0F172A',
  },

  /* Single Gun Connected */
  singleContainer: {
    width: '100%',
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 14,
  },
  singleGunHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },

  /* Standard Metrics Grid */
  metricsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  metricItem: {
    flex: 1,
    alignItems: 'center',
  },
  divider: {
    width: 1,
    height: '100%',
    backgroundColor: '#F1F5F9',
  },
  metricLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  metricValue: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0F172A',
  },
});
