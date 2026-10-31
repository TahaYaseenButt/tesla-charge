import React, { useEffect, useState, useRef } from 'react';
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
import { SimulatorModal, SimulatorButton } from '@/components/SimulatorModal';

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
  const [serverTimeOffset, setServerTimeOffset] = useState<number>(0);
  const [liveAccumulatedA, setLiveAccumulatedA] = useState<number>(0);
  const [liveAccumulatedB, setLiveAccumulatedB] = useState<number>(0);

  // In-app UI Simulator hook for desk testing without physical cars
  const { scenario, isSimulating, gunA: simGunA, gunB: simGunB } = useSimulator();
  const [simModalVisible, setSimModalVisible] = useState(false);

  const prevStatus1Ref = useRef<string | null>(null);
  const prevStatus2Ref = useRef<string | null>(null);
  const prevActiveTxIdRef = useRef<string | null>(null);

  // Safety fallback: Ensure skeleton loader never hangs indefinitely if offline
  useEffect(() => {
    const safetyTimer = setTimeout(() => {
      setLoading(false);
    }, 1200);
    return () => clearTimeout(safetyTimer);
  }, []);

  useEffect(() => {
    if (!CHARGER_ID || !isAuthenticated) return;

    let isMounted = true;

    // 1. Immediately read from user local storage so UI displays in 0ms without waiting for network
    getLocalChargerData(CHARGER_ID).then((local) => {
      if (isMounted && local) {
        setChargerData((prev: any) => prev || local);
        setLoading(false);
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
    const unsubscribe = subscribeToLiveStatus(CHARGER_ID, (data) => {
      if (!isMounted || !data) return;
      setLoading(false);

      if (data.serverTime) {
        const serverMs = new Date(data.serverTime).getTime();
        if (!isNaN(serverMs)) {
          setServerTimeOffset(serverMs - Date.now());
        }
      }

      if (data.charger) {
        setChargerData(data.charger);
        saveLocalChargerData(CHARGER_ID, data.charger);
      }

      const connectorsList = Array.isArray(data.connectors) ? data.connectors : Object.values(data.connectors || {});
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

      const active = data.activeTransaction || c1?.activeTx || c2?.activeTx;
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

      if (data.lastCompletedTx) {
        const done = data.lastCompletedTx;
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
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [CHARGER_ID, isAuthenticated, user?.uid]);

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

  // Track true Firebase server time with 300s tolerance (or always active if plugged in or simulating)
  const nowServer = Date.now() + serverTimeOffset;
  const lastHbTime = chargerData?.lastHeartbeat ? new Date(chargerData.lastHeartbeat).getTime() : 0;
  const hasRecentHeartbeat = lastHbTime > 0 ? nowServer - lastHbTime < 300000 : true;
  const isOnline = isSimulating || ((chargerData?.status === 'Online' || isActivelyEngaged) && (hasRecentHeartbeat || isActivelyEngaged));

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

  // Session energy delivered for Gun A
  const txA = activeTx1Data || connector1Data?.activeTx;
  const deliveredA = Number(txA?.energyDeliveredKwh) || (txA?.energyDeliveredWh ? Number((txA.energyDeliveredWh / 1000).toFixed(2)) : 0);
  const mStartA = txA?.meterStart !== undefined && txA?.meterStart !== null && Number(txA.meterStart) > 0 ? Number(txA.meterStart) : null;
  const currentEnergyWhA = tel1?.energyWh || (tel1?.energyKwh ? Math.round(Number(tel1.energyKwh) * 1000) : null);
  const computedA =
    mStartA !== null && currentEnergyWhA !== null && currentEnergyWhA >= mStartA
      ? Math.max(0, (currentEnergyWhA - mStartA) / 1000)
      : 0;
  const baseEnergyA = computedA > 0 ? computedA : deliveredA > 0 ? deliveredA : 0;
  const sessionEnergyA = isSimulating ? simGunA.energyKwh : baseEnergyA + liveAccumulatedA;
  const lifetimeMeterA = tel1?.energyKwh || (tel1?.energyWh ? (tel1.energyWh / 1000).toFixed(2) : '0.00');
  const energyA = isSimulating ? simGunA.energyKwh.toFixed(2) : sessionEnergyA.toFixed(2);

  // Telemetry for Gun B (Connector 2) - directly from live OCPP server or simulator
  const tel2 = connector2Data?.telemetry;
  const powerB = isSimulating ? simGunB.powerKw : Number(tel2?.powerKw || 0);
  const voltageB = isSimulating ? simGunB.voltage : tel2?.voltage ? Math.round(Number(tel2.voltage)) : (tel2?.voltageL1 ? Math.round(Number(tel2.voltageL1)) : 0);
  const currentB = isSimulating ? simGunB.current : Number(tel2?.currentL1 || 0);
  const socB = isSimulating ? (simGunB.soc > 0 ? simGunB.soc : null) : (typeof tel2?.soc === 'number' && tel2.soc > 0 ? tel2.soc : null);

  // Session energy delivered for Gun B
  const txB = activeTx2Data || connector2Data?.activeTx;
  const deliveredB = Number(txB?.energyDeliveredKwh) || (txB?.energyDeliveredWh ? Number((txB.energyDeliveredWh / 1000).toFixed(2)) : 0);
  const mStartB = txB?.meterStart !== undefined && txB?.meterStart !== null && Number(txB.meterStart) > 0 ? Number(txB.meterStart) : null;
  const currentEnergyWhB = tel2?.energyWh || (tel2?.energyKwh ? Math.round(Number(tel2.energyKwh) * 1000) : null);
  const computedB =
    mStartB !== null && currentEnergyWhB !== null && currentEnergyWhB >= mStartB
      ? Math.max(0, (currentEnergyWhB - mStartB) / 1000)
      : 0;
  const baseEnergyB = computedB > 0 ? computedB : deliveredB > 0 ? deliveredB : 0;
  const sessionEnergyB = isSimulating ? simGunB.energyKwh : baseEnergyB + liveAccumulatedB;
  const lifetimeMeterB = tel2?.energyKwh || (tel2?.energyWh ? (tel2.energyWh / 1000).toFixed(2) : '0.00');
  const energyB = isSimulating ? simGunB.energyKwh.toFixed(2) : sessionEnergyB.toFixed(2);

  // Total Power
  const totalPower = is30kW ? Number(powerA).toFixed(1) : (powerA + powerB).toFixed(1);

  // Real-time Cost Calculation using Tariff Rate (no decimals, clean rounded integer)
  const rate = chargerData?.tariffRate && Number(chargerData.tariffRate) > 0
    ? Number(chargerData.tariffRate)
    : tariffRate && tariffRate > 0
    ? tariffRate
    : 125;
  const curr = 'PKR';
  const costA = isSimulating ? Math.round(simGunA.cost).toString() : Math.round(sessionEnergyA * rate).toString();
  const costB = isSimulating ? Math.round(simGunB.cost).toString() : Math.round(sessionEnergyB * rate).toString();
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

  // Active Battery State of Charge (SoC %)
  const activeSocA = isSimulating
    ? (simGunA.soc > 0 ? simGunA.soc : null)
    : typeof tel1?.soc === 'number' && tel1.soc > 0
    ? tel1.soc
    : typeof activeTx1Data?.soc === 'number' && activeTx1Data.soc > 0
    ? activeTx1Data.soc
    : typeof activeTx1Data?.socCurrent === 'number' && activeTx1Data.socCurrent > 0
    ? activeTx1Data.socCurrent
    : null;

  const activeSocB = isSimulating
    ? (simGunB.soc > 0 ? simGunB.soc : null)
    : typeof tel2?.soc === 'number' && tel2.soc > 0
    ? tel2.soc
    : typeof activeTx2Data?.soc === 'number' && activeTx2Data.soc > 0
    ? activeTx2Data.soc
    : typeof activeTx2Data?.socCurrent === 'number' && activeTx2Data.socCurrent > 0
    ? activeTx2Data.socCurrent
    : null;

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

  if (loading && !chargerData) {
    return <DashboardSkeleton isSingleGun={is30kW} />;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header: Station ID, Simulator Test Trigger & Unified Minimal Status Badge */}
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Image
            source={require('@/assets/images/brand-logo.png')}
            style={styles.headerLogo}
            resizeMode="contain"
          />
          <Text style={styles.stationId}>{CHARGER_ID.toUpperCase()}</Text>
          <SimulatorButton onOpen={() => setSimModalVisible(true)} />
        </View>
        <View style={[styles.statusBadge, { backgroundColor: activeTheme.bg, borderColor: activeTheme.border || 'transparent', borderWidth: 1 }]}>
          <View style={[styles.statusDot, { backgroundColor: activeTheme.color }]} />
          <Text style={[styles.statusText, { color: activeTheme.color }]}>
            {activeTheme.label}
          </Text>
        </View>
      </View>

      {/* Prominent Hero Image */}
      <View style={styles.heroChargerContainer}>
        <Image source={safeHeroImage} style={styles.heroChargerImage} resizeMode="contain" />
      </View>

      {/* Battery State of Charge Hero Card (Main Screen - Minimalist & Professional) */}
      {/* Main Hero Section: Dual Gun Individual Showcase when both connected, or Single Gun Hero */}
      {bothConnected ? (
        /* Dual Gun Live Showcase: Both cars displayed side-by-side with individual SoC, Price, and Power */
        <View style={styles.dualHeroContainer}>
          {/* Gun A Hero Card */}
          <View style={[styles.dualHeroCard, isGunACharging && styles.dualHeroCardActive]}>
            <View style={styles.dualHeroHeader}>
              <View style={styles.dualHeroTitleRow}>
                <View style={[styles.gunDot, { backgroundColor: themeA.color }]} />
                <Text style={styles.dualHeroTitle}>GUN A</Text>
              </View>
              <View style={[styles.miniStatusPill, { backgroundColor: themeA.bg }]}>
                <Text style={[styles.miniStatusText, { color: themeA.color }]}>{themeA.label}</Text>
              </View>
            </View>

            {/* Battery SoC */}
            <View style={styles.dualHeroSocRow}>
              <Text style={styles.dualHeroSocPercent}>{hasSocA ? `${activeSocA}%` : '--'}</Text>
              <Text style={styles.dualHeroSocLabel}>BATTERY</Text>
            </View>
            <View style={styles.batteryTrackMinimal}>
              <View
                style={[
                  styles.batteryFillMinimal,
                  {
                    width: `${hasSocA ? Math.min(100, Math.max(4, activeSocA!)) : 0}%`,
                    backgroundColor: isGunACharging ? '#10B981' : hasSocA && activeSocA! > 20 ? '#0F172A' : '#EF4444',
                  },
                ]}
              />
            </View>

            {/* Individual Gun A Price */}
            <View style={styles.dualHeroPriceSection}>
              <Text style={styles.dualHeroPriceVal}>{costA}</Text>
              <Text style={styles.dualHeroPriceCurr}>{curr}</Text>
            </View>

            {/* Speed & Energy */}
            <Text style={styles.dualHeroMetaText}>
              {Number(powerA).toFixed(1)} kW • {energyA} kWh
            </Text>
          </View>

          {/* Gun B Hero Card */}
          <View style={[styles.dualHeroCard, isGunBCharging && styles.dualHeroCardActive]}>
            <View style={styles.dualHeroHeader}>
              <View style={styles.dualHeroTitleRow}>
                <View style={[styles.gunDot, { backgroundColor: themeB.color }]} />
                <Text style={styles.dualHeroTitle}>GUN B</Text>
              </View>
              <View style={[styles.miniStatusPill, { backgroundColor: themeB.bg }]}>
                <Text style={[styles.miniStatusText, { color: themeB.color }]}>{themeB.label}</Text>
              </View>
            </View>

            {/* Battery SoC */}
            <View style={styles.dualHeroSocRow}>
              <Text style={styles.dualHeroSocPercent}>{hasSocB ? `${activeSocB}%` : '--'}</Text>
              <Text style={styles.dualHeroSocLabel}>BATTERY</Text>
            </View>
            <View style={styles.batteryTrackMinimal}>
              <View
                style={[
                  styles.batteryFillMinimal,
                  {
                    width: `${hasSocB ? Math.min(100, Math.max(4, activeSocB!)) : 0}%`,
                    backgroundColor: isGunBCharging ? '#10B981' : hasSocB && activeSocB! > 20 ? '#0F172A' : '#EF4444',
                  },
                ]}
              />
            </View>

            {/* Individual Gun B Price */}
            <View style={styles.dualHeroPriceSection}>
              <Text style={styles.dualHeroPriceVal}>{costB}</Text>
              <Text style={styles.dualHeroPriceCurr}>{curr}</Text>
            </View>

            {/* Speed & Energy */}
            <Text style={styles.dualHeroMetaText}>
              {Number(powerB).toFixed(1)} kW • {energyB} kWh
            </Text>
          </View>
        </View>
      ) : (
        /* Single Gun or Standby Hero Layout */
        <>
          {displaySoc !== null && (
            <View style={styles.batteryHeroCard}>
              <View style={styles.batteryHeroTopRow}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <View style={[styles.statusDot, { backgroundColor: isActivelyChargingNow ? '#10B981' : '#64748B', width: 6, height: 6, borderRadius: 3, marginRight: 0 }]} />
                      <Text style={styles.batteryHeroTitle}>
                        {displaySocGunLabel} {isActivelyChargingNow ? '• CHARGING' : '• BATTERY'}
                      </Text>
                    </View>
                    <Text style={styles.batteryHeroPercent}>{displaySoc}%</Text>
                  </View>
                  <View style={styles.batteryTrackMinimal}>
                    <View
                      style={[
                        styles.batteryFillMinimal,
                        {
                          width: `${Math.min(100, Math.max(4, displaySoc))}%`,
                          backgroundColor: isActivelyChargingNow ? '#10B981' : displaySoc > 20 ? '#0F172A' : '#EF4444',
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.batteryHeroSubtitle}>
                    {isActivelyChargingNow ? 'Charging session in progress' : 'Plugged in & Ready'}
                  </Text>
                </View>
              </View>
            </View>
          )}

          {/* Power & Live Cost (PKR Below Amount) */}
          <View style={styles.powerSection}>
            {isGunACharging ? (
              <View style={styles.priceHeroColumn}>
                <Text style={styles.priceHeroVal}>{costA}</Text>
                <Text style={styles.priceHeroCurr}>{curr} (Gun A) • Speed: {Number(powerA).toFixed(1)} kW</Text>
              </View>
            ) : isGunBCharging ? (
              <View style={styles.priceHeroColumn}>
                <Text style={styles.priceHeroVal}>{costB}</Text>
                <Text style={styles.priceHeroCurr}>{curr} (Gun B) • Speed: {Number(powerB).toFixed(1)} kW</Text>
              </View>
            ) : hasAnyGunConnected ? (
              <View style={styles.priceHeroColumn}>
                <Text style={styles.priceHeroVal}>{Number(totalCost.replace(/,/g, '')) > 0 ? totalCost : 'READY'}</Text>
                <Text style={styles.priceHeroCurr}>
                  {Number(totalCost.replace(/,/g, '')) > 0 ? `${curr} (session)` : 'PLUGGED IN • READY TO CHARGE'}
                </Text>
              </View>
            ) : lastSessionCost > 0 ? (
              <View style={styles.priceHeroColumn}>
                <Text style={styles.priceHeroVal}>{lastSessionCost.toLocaleString()}</Text>
                <Text style={styles.priceHeroCurr}>{`${curr} (last session)`}</Text>
              </View>
            ) : (
              <View style={styles.powerRow}>
                <Text style={styles.powerValue}>0.0</Text>
                <Text style={styles.powerUnit}>kW</Text>
              </View>
            )}
          </View>
        </>
      )}

      {/* Dynamic Data Layout */}
      {is30kW ? (
        /* 30kW Single Gun Model */
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
              <Text style={styles.metricLabel}>ENERGY</Text>
              <Text style={styles.metricValue}>{energyA} kWh</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.metricItem}>
              <Text style={styles.metricLabel}>POWER</Text>
              <Text style={styles.metricValue}>{Number(powerA).toFixed(1)} kW</Text>
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
        /* Dual Gun View: Both Gun A and Gun B Cards Always Visible Side by Side */
        <View style={styles.dualContainer}>
          {/* Gun A Column */}
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

            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, marginTop: 4 }}>
              <Text style={styles.gunPower}>{Number(powerA).toFixed(1)} kW</Text>
              {hasSocA ? (
                <View style={{ backgroundColor: '#F1F5F9', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#0F172A' }}>{activeSocA}%</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.gunMetricRow}>
              <Text style={styles.gunMetricLabel}>Voltage</Text>
              <Text style={styles.gunMetricVal}>{voltageA} V</Text>
            </View>
            <View style={styles.gunMetricRow}>
              <Text style={styles.gunMetricLabel}>Current</Text>
              <Text style={styles.gunMetricVal}>{currentA} A</Text>
            </View>
            <View style={styles.gunMetricRow}>
              <Text style={styles.gunMetricLabel}>Energy</Text>
              <Text style={styles.gunMetricVal}>{energyA} kWh</Text>
            </View>
          </View>

          {/* Gun B Column */}
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

            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, marginTop: 4 }}>
              <Text style={styles.gunPower}>{Number(powerB).toFixed(1)} kW</Text>
              {hasSocB ? (
                <View style={{ backgroundColor: '#F1F5F9', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#0F172A' }}>{activeSocB}%</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.gunMetricRow}>
              <Text style={styles.gunMetricLabel}>Voltage</Text>
              <Text style={styles.gunMetricVal}>{voltageB} V</Text>
            </View>
            <View style={styles.gunMetricRow}>
              <Text style={styles.gunMetricLabel}>Current</Text>
              <Text style={styles.gunMetricVal}>{currentB} A</Text>
            </View>
            <View style={styles.gunMetricRow}>
              <Text style={styles.gunMetricLabel}>Energy</Text>
              <Text style={styles.gunMetricVal}>{energyB} kWh</Text>
            </View>
          </View>
        </View>
      )}

      {/* UI Test Simulator Modal for Testing without physical cars */}
      <SimulatorModal visible={simModalVisible} onClose={() => setSimModalVisible(false)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: Platform.OS === 'ios' ? 56 : 36,
    paddingBottom: 40,
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
    marginBottom: 8,
  },
  headerLogo: {
    width: 26,
    height: 26,
  },
  stationId: {
    fontSize: 20,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: 1,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
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

  /* Hero Charger Image */
  heroChargerContainer: {
    width: '100%',
    height: 320,
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 8,
  },
  heroChargerImage: {
    width: '100%',
    height: 320,
    maxWidth: 500,
  },

  /* Battery Hero Card on Main Screen */
  batteryHeroCard: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginHorizontal: 4,
    marginBottom: 20,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  batteryHeroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  batteryTrackMinimal: {
    height: 4,
    backgroundColor: '#E2E8F0',
    borderRadius: 2,
    overflow: 'hidden',
    marginVertical: 8,
  },
  batteryFillMinimal: {
    height: '100%',
    borderRadius: 2,
  },
  batteryHeroTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  batteryHeroPercent: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0F172A',
  },
  batteryHeroSubtitle: {
    fontSize: 12,
    fontWeight: '500',
    color: '#64748B',
    marginTop: 2,
  },
  dualHeroContainer: {
    flexDirection: 'row',
    gap: 12,
    marginHorizontal: 4,
    marginBottom: 20,
  },
  dualHeroCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 16,
    padding: 14,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
  dualHeroCardActive: {
    borderColor: 'rgba(16, 185, 129, 0.4)',
    backgroundColor: '#FAFCFF',
  },
  dualHeroHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  dualHeroTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dualHeroTitle: {
    fontSize: 12,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: 0.5,
  },
  dualHeroSocRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  dualHeroSocPercent: {
    fontSize: 22,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -0.5,
  },
  dualHeroSocLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 1,
  },
  dualHeroPriceSection: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    marginTop: 8,
    marginBottom: 2,
  },
  dualHeroPriceVal: {
    fontSize: 28,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -0.5,
  },
  dualHeroPriceCurr: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0284C7',
    letterSpacing: 0.8,
  },
  dualHeroMetaText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 2,
  },
  dualBatterySub: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 2,
  },
  priceHeroColumn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  priceHeroVal: {
    fontSize: 54,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -1.5,
    fontVariant: ['tabular-nums'],
  },
  priceHeroCurr: {
    fontSize: 13,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  powerSubtext: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 4,
  },

  /* Power Section */
  powerSection: {
    alignItems: 'center',
    marginBottom: 28,
  },
  powerRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
  },
  powerValue: {
    fontSize: 56,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -2,
  },
  powerUnit: {
    fontSize: 20,
    fontWeight: '800',
    color: '#64748B',
    marginLeft: 6,
  },
  costSubtext: {
    fontSize: 13,
    fontWeight: '700',
    color: '#64748B',
    marginTop: 6,
    letterSpacing: 0.3,
  },

  /* Dual Gun Layout */
  dualContainer: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  gunCard: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  gunHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
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
    fontSize: 11,
    fontWeight: '800',
    color: '#475569',
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
    fontSize: 20,
    fontWeight: '900',
    color: '#0F172A',
    marginBottom: 10,
  },
  gunMetricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  gunMetricLabel: {
    fontSize: 11,
    color: '#94A3B8',
    fontWeight: '600',
  },
  gunMetricVal: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0F172A',
  },

  /* Single Gun Connected */
  singleContainer: {
    width: '100%',
  },
  singleGunHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },

  /* Standard Metrics Grid */
  metricsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 14,
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
    fontSize: 10,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  metricValue: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A',
  },
});
