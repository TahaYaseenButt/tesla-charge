import React, { useEffect, useState } from 'react';
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
import { ref, onValue } from 'firebase/database';
import { doc, onSnapshot, collection, query, orderBy, limit } from 'firebase/firestore';
import { router, Redirect } from 'expo-router';
import { rtdb, db, livePath, fetchFirestoreDoc } from '@/config/firebase';
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
  Preparing: { color: '#D97706', label: 'CONNECTED', bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.25)' },
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
    isLoading: authLoading,
    user,
    logout,
    tariffRate,
    currency,
  } = useAuth();

  const CHARGER_ID = configuredId || 'charger1';

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

  // Fix Issue 4: Track true Firebase server time offset so clock drifts never wrongly show station offline
  useEffect(() => {
    const offsetRef = ref(rtdb, '.info/serverTimeOffset');
    const unsubOffset = onValue(offsetRef, (snap) => {
      setServerTimeOffset(snap.val() || 0);
    });
    return () => unsubOffset();
  }, []);

  // Safety fallback: Ensure skeleton loader never hangs indefinitely if offline
  useEffect(() => {
    const safetyTimer = setTimeout(() => {
      setLoading(false);
    }, 1200);
    return () => clearTimeout(safetyTimer);
  }, []);

  useEffect(() => {
    if (!CHARGER_ID || !isAuthenticated) return;

    // Static setup info (model, vendor, location) from Firestore; live fields come from RTDB
    let staticInfo: Record<string, any> = {};
    let liveInfo: Record<string, any> = {};
    const publishCharger = () => {
      const merged = { ...staticInfo, ...liveInfo };
      setChargerData(merged);
      saveLocalChargerData(CHARGER_ID, merged);
    };

    // 1. Immediately read from user local storage so UI displays in 0ms without waiting for network
    getLocalChargerData(CHARGER_ID).then((local) => {
      if (local) {
        setChargerData((prev: any) => prev || local);
        setLoading(false);
      }
    });
    getLocalConnectorData(CHARGER_ID, '1').then((d) => {
      if (d) setConnector1Data((prev: any) => prev || d);
    });
    getLocalConnectorData(CHARGER_ID, '2').then((d) => {
      if (d) setConnector2Data((prev: any) => prev || d);
    });
    getLocalActiveTx(CHARGER_ID).then((tx) => {
      if (tx && tx.status === 'Charging') setActiveTxData((prev: any) => prev || tx);
    });
    getLocalTransactions(CHARGER_ID, user?.uid).then((list) => {
      if (list && list.length > 0) {
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

    // 2. Initial fetch via HTTPS REST for charger and connectors (fast startup & fallback)
    fetchFirestoreDoc('chargers', CHARGER_ID)
      .then((data) => {
        if (data) {
          const { status: st, lastHeartbeat: hb, ...rest } = data;
          staticInfo = rest;
          if (!liveInfo.status && st) {
            liveInfo = { status: st, lastHeartbeat: hb || null };
          }
          publishCharger();
          setLoading(false);
        }
      })
      .catch(() => {});

    fetchFirestoreDoc(`chargers/${CHARGER_ID}/connectors`, '1')
      .then((c1) => {
        if (c1) {
          setConnector1Data((prev: any) => prev || c1);
          if (c1.activeTx && c1.status === 'Charging') setActiveTx1Data((prev: any) => prev || c1.activeTx);
          saveLocalConnectorData(CHARGER_ID, '1', c1);
        }
      })
      .catch(() => {});

    fetchFirestoreDoc(`chargers/${CHARGER_ID}/connectors`, '2')
      .then((c2) => {
        if (c2) {
          setConnector2Data((prev: any) => prev || c2);
          if (c2.activeTx && c2.status === 'Charging') setActiveTx2Data((prev: any) => prev || c2.activeTx);
          saveLocalConnectorData(CHARGER_ID, '2', c2);
        }
      })
      .catch(() => {});

    // 3. Single Realtime Database listener for ALL live data of this charger
    let lastActiveTxId: string | null = null;
    let lastCompletedId: string | null = null;

    const liveRef = ref(rtdb, livePath(CHARGER_ID));
    const unsubLive = onValue(
      liveRef,
      (snap) => {
        const live = snap.val() || {};
        setLoading(false);

        // Online status + heartbeat: keep whichever is newer (Firestore vs RTDB)
        const rtdbHb = live.lastHeartbeat || null;
        const firestoreHb = staticInfo.lastHeartbeat || liveInfo.lastHeartbeat || null;
        const isRtdbNewer =
          rtdbHb && firestoreHb
            ? new Date(rtdbHb).getTime() >= new Date(firestoreHb).getTime()
            : !!rtdbHb;

        liveInfo = {
          status: isRtdbNewer ? live.status || 'Offline' : liveInfo.status || 'Online',
          lastHeartbeat: isRtdbNewer ? rtdbHb : firestoreHb,
        };
        publishCharger();

        // Connectors (Gun A / Gun B) with telemetry (supports both object and 1-indexed array from RTDB)
        const c1 =
          live.connectors?.['1'] ||
          (Array.isArray(live.connectors) && live.connectors[1] ? live.connectors[1] : null);
        const c2 =
          live.connectors?.['2'] ||
          (Array.isArray(live.connectors) && live.connectors[2] ? live.connectors[2] : null);
        if (c1) {
          setConnector1Data((prev: any) => ({
            ...c1,
            activeTx: c1.status === 'Charging' ? (c1.activeTx || prev?.activeTx || null) : null,
          }));
          saveLocalConnectorData(CHARGER_ID, '1', c1);
        }
        if (c2) {
          setConnector2Data((prev: any) => ({
            ...c2,
            activeTx: c2.status === 'Charging' ? (c2.activeTx || prev?.activeTx || null) : null,
          }));
          saveLocalConnectorData(CHARGER_ID, '2', c2);
        }

        // Active charging session(s) - strictly null if connector is not actively charging
        const activeList = Object.values(live.activeTx || {}).filter(Boolean) as any[];
        const txA = live.activeTx?.['1'] || (Array.isArray(live.activeTx) ? live.activeTx[1] : null);
        const txB = live.activeTx?.['2'] || (Array.isArray(live.activeTx) ? live.activeTx[2] : null);
        if (txA && c1?.status === 'Charging') setActiveTx1Data(txA);
        else setActiveTx1Data(null);

        if (txB && c2?.status === 'Charging') setActiveTx2Data(txB);
        else setActiveTx2Data(null);

        const primaryTx = (txB && c2?.status === 'Charging') ? txB : (txA && c1?.status === 'Charging') ? txA : null;
        if (primaryTx) {
          setActiveTxData(primaryTx);
          saveLocalActiveTx(CHARGER_ID, primaryTx);
        } else {
          setActiveTxData(null);
        }

        // Add new sessions to local history cache once (not on every meter value)
        for (const tx of activeList) {
          if (!tx?.transactionId) continue;
          const txId = String(tx.transactionId);
          if (txId !== lastActiveTxId) {
            lastActiveTxId = txId;
            mergeLocalTransaction(CHARGER_ID, { id: txId, ...tx });
          }
        }

        // Finished session published by server -> update local history with 0 Firestore reads
        const done = live.lastCompletedTx;
        if (
          done &&
          String(done.transactionId || done.id) !== '275384' &&
          String(done.transactionId || done.id) !== '72089' &&
          (Number(done.energyDeliveredKwh) > 0 || Number(done.energyDeliveredWh) > 0)
        ) {
          setLastCompletedTx(done);
          if (done?.transactionId && String(done.transactionId) !== lastCompletedId) {
            lastCompletedId = String(done.transactionId);
            mergeLocalTransaction(CHARGER_ID, { id: String(done.transactionId), ...done });
          }
        }
      },
      (err) => {
        // Seamless fallback to Firestore real-time snapshots below
        setLoading(false);
      }
    );

    // 4. Firestore Real-Time snapshots (ensures live UI updates even if RTDB rules restrict access)
    const unsubChargerSnap = onSnapshot(
      doc(db, 'chargers', CHARGER_ID),
      (snap) => {
        if (snap.exists()) {
          const d = snap.data();
          const { status: st, lastHeartbeat: hb, ...rest } = d;
          staticInfo = rest;
          liveInfo = {
            status: st || 'Online',
            lastHeartbeat: hb || new Date().toISOString(),
          };
          publishCharger();
          setLoading(false);
        }
      },
      () => {
        setLoading(false);
      }
    );

    const unsubConn1Snap = onSnapshot(
      doc(db, 'chargers', CHARGER_ID, 'connectors', '1'),
      (snap) => {
        if (snap.exists()) {
          const c1 = snap.data();
          setConnector1Data(c1);
          if (c1.activeTx) {
            setActiveTx1Data(c1.activeTx);
          } else {
            setActiveTx1Data(null);
          }
          saveLocalConnectorData(CHARGER_ID, '1', c1);
        }
      },
      () => {}
    );

    const unsubConn2Snap = onSnapshot(
      doc(db, 'chargers', CHARGER_ID, 'connectors', '2'),
      (snap) => {
        if (snap.exists()) {
          const c2 = snap.data();
          setConnector2Data(c2);
          if (c2.activeTx) {
            setActiveTx2Data(c2.activeTx);
          } else {
            setActiveTx2Data(null);
          }
          saveLocalConnectorData(CHARGER_ID, '2', c2);
        }
      },
      () => {}
    );

    // 5. Real-time query for latest completed transaction on this charger with actual delivered energy
    const qLatestTx = query(
      collection(db, 'transactions'),
      orderBy('startTime', 'desc')
    );
    const unsubLatestTx = onSnapshot(
      qLatestTx,
      (snapshot) => {
        if (!snapshot.empty) {
          const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

          // Actively charging transactions for Gun 1 & Gun 2
          const act1 = list.find(
            (tx: any) =>
              (!tx.chargePointId || tx.chargePointId.toLowerCase() === CHARGER_ID.toLowerCase()) &&
              Number(tx.connectorId || 1) === 1 &&
              (tx.status === 'Charging' || (!tx.stopTime && Number(tx.meterStart) > 0))
          );
          setActiveTx1Data(act1 || null);

          const act2 = list.find(
            (tx: any) =>
              (!tx.chargePointId || tx.chargePointId.toLowerCase() === CHARGER_ID.toLowerCase()) &&
              Number(tx.connectorId) === 2 &&
              (tx.status === 'Charging' || (!tx.stopTime && Number(tx.meterStart) > 0))
          );
          setActiveTx2Data(act2 || null);

          const match = list.find(
            (tx: any) =>
              (!tx.chargePointId || tx.chargePointId.toLowerCase() === CHARGER_ID.toLowerCase()) &&
              String(tx.transactionId || tx.id) !== '275384' &&
              String(tx.transactionId || tx.id) !== '72089' &&
              (Number(tx.energyDeliveredKwh) > 0 || Number(tx.energyDeliveredWh) > 0)
          );
          if (match) {
            setLastCompletedTx(match);
            mergeLocalTransaction(CHARGER_ID, match, user?.uid);
          }
        }
      },
      () => {}
    );

    return () => {
      unsubLive();
      unsubChargerSnap();
      unsubConn1Snap();
      unsubConn2Snap();
      unsubLatestTx();
    };
  }, [CHARGER_ID, isAuthenticated, user?.uid]);

  // 30kW single-gun detection
  const is30kW =
    chargerModel?.toLowerCase().includes('30') ||
    chargerData?.model?.toLowerCase().includes('30');

  // Connected statuses list: Preparing, Charging, Suspended, Finishing
  const CONNECTED_STATUS_LIST = ['Charging', 'Preparing', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'];

  const rawStatus1 = connector1Data?.status || 'Available';
  const rawStatus2 = connector2Data?.status || 'Available';

  const isGunAPlugged = CONNECTED_STATUS_LIST.includes(rawStatus1);
  const isGunBPlugged = !is30kW && CONNECTED_STATUS_LIST.includes(rawStatus2);
  const isActivelyEngaged = isGunAPlugged || isGunBPlugged;

  // Track true Firebase server time with 300s tolerance (or always active if plugged in)
  const nowServer = Date.now() + serverTimeOffset;
  const lastHbTime = chargerData?.lastHeartbeat ? new Date(chargerData.lastHeartbeat).getTime() : 0;
  const hasRecentHeartbeat = lastHbTime > 0 ? nowServer - lastHbTime < 300000 : true;
  const isOnline = (chargerData?.status === 'Online' || isActivelyEngaged) && (hasRecentHeartbeat || isActivelyEngaged);

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

  // Telemetry for Gun A (Connector 1) - strictly 0 when not connected or no live reading
  const tel1 = connector1Data?.telemetry;
  const powerA = isOnline && isGunAConnected ? (tel1?.powerKw || 0) : 0;
  const voltageA = isOnline && isGunAConnected && tel1?.voltage ? Math.round(Number(tel1.voltage)) : 0;
  const currentA = isOnline && isGunAConnected ? (tel1?.currentL1 || 0) : 0;
  // Session energy delivered for Gun A
  const txA = activeTx1Data || connector1Data?.activeTx;
  const deliveredA = Number(txA?.energyDeliveredKwh) || (txA?.energyDeliveredWh ? Number((txA.energyDeliveredWh / 1000).toFixed(2)) : 0);
  const mStartA = txA?.meterStart !== undefined && txA?.meterStart !== null && Number(txA.meterStart) > 0 ? Number(txA.meterStart) : null;
  const currentEnergyWhA = tel1?.energyWh || (tel1?.energyKwh ? Math.round(Number(tel1.energyKwh) * 1000) : null);
  const computedA =
    isGunAConnected && mStartA !== null && currentEnergyWhA !== null && currentEnergyWhA >= mStartA
      ? Math.max(0, (currentEnergyWhA - mStartA) / 1000)
      : 0;
  const baseEnergyA = isGunAConnected
    ? (computedA > 0 ? computedA : deliveredA > 0 ? deliveredA : 0)
    : 0;
  const sessionEnergyA = isGunAConnected
    ? (baseEnergyA + liveAccumulatedA)
    : 0;
  const lifetimeMeterA = tel1?.energyKwh || (tel1?.energyWh ? (tel1.energyWh / 1000).toFixed(2) : '0.00');
  const energyA = sessionEnergyA.toFixed(2);

  // Telemetry for Gun B (Connector 2) - strictly 0 when not connected or no live reading
  const tel2 = connector2Data?.telemetry;
  const powerB = isOnline && !is30kW && isGunBConnected ? (tel2?.powerKw || 0) : 0;
  const voltageB = isOnline && !is30kW && isGunBConnected && tel2?.voltage ? Math.round(Number(tel2.voltage)) : 0;
  const currentB = isOnline && !is30kW && isGunBConnected ? (tel2?.currentL1 || 0) : 0;
  
  // Session energy delivered for Gun B
  const txB = activeTx2Data || connector2Data?.activeTx;
  const deliveredB = Number(txB?.energyDeliveredKwh) || (txB?.energyDeliveredWh ? Number((txB.energyDeliveredWh / 1000).toFixed(2)) : 0);
  const mStartB = txB?.meterStart !== undefined && txB?.meterStart !== null && Number(txB.meterStart) > 0 ? Number(txB.meterStart) : null;
  const currentEnergyWhB = tel2?.energyWh || (tel2?.energyKwh ? Math.round(Number(tel2.energyKwh) * 1000) : null);
  const computedB =
    !is30kW && isGunBConnected && mStartB !== null && currentEnergyWhB !== null && currentEnergyWhB >= mStartB
      ? Math.max(0, (currentEnergyWhB - mStartB) / 1000)
      : 0;
  const baseEnergyB = !is30kW && isGunBConnected
    ? (computedB > 0 ? computedB : deliveredB > 0 ? deliveredB : 0)
    : 0;
  const sessionEnergyB = !is30kW && isGunBConnected
    ? (baseEnergyB + liveAccumulatedB)
    : 0;
  const lifetimeMeterB = tel2?.energyKwh || (tel2?.energyWh ? (tel2.energyWh / 1000).toFixed(2) : '0.00');
  const energyB = sessionEnergyB.toFixed(2);

  // Total Power
  const totalPower = is30kW ? Number(powerA).toFixed(1) : (powerA + powerB).toFixed(1);

  // Real-time Cost Calculation using Tariff Rate (no decimals, clean rounded integer)
  const rate = chargerData?.tariffRate && Number(chargerData.tariffRate) > 0
    ? Number(chargerData.tariffRate)
    : tariffRate && tariffRate > 0
    ? tariffRate
    : 125;
  const curr = 'PKR';
  const costA = Math.round(sessionEnergyA * rate).toString();
  const costB = Math.round(sessionEnergyB * rate).toString();
  const totalEnergy = is30kW
    ? energyA
    : (sessionEnergyA + sessionEnergyB).toFixed(2);
  const totalCost = Math.round(Number(totalEnergy) * rate).toLocaleString();
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
  const activeSocA =
    typeof tel1?.soc === 'number' && tel1.soc > 0
      ? tel1.soc
      : typeof activeTx1Data?.soc === 'number' && activeTx1Data.soc > 0
      ? activeTx1Data.soc
      : typeof activeTx1Data?.socCurrent === 'number' && activeTx1Data.socCurrent > 0
      ? activeTx1Data.socCurrent
      : null;

  const activeSocB =
    typeof tel2?.soc === 'number' && tel2.soc > 0
      ? tel2.soc
      : typeof activeTx2Data?.soc === 'number' && activeTx2Data.soc > 0
      ? activeTx2Data.soc
      : typeof activeTx2Data?.socCurrent === 'number' && activeTx2Data.socCurrent > 0
      ? activeTx2Data.socCurrent
      : null;

  const currentChargingSoc = isGunBConnected ? activeSocB : isGunAConnected ? activeSocA : (activeSocB || activeSocA);
  // Strictly hide SoC battery card when no car is connected (never show stale 79% when unplugged)
  const displaySoc = hasAnyGunConnected && typeof currentChargingSoc === 'number' && currentChargingSoc > 0
    ? currentChargingSoc
    : null;
  const isActivelyChargingNow = isOnline && (status1 === 'Charging' || status2 === 'Charging');

  if (authLoading) {
    return <DashboardSkeleton isSingleGun={is30kW} />;
  }

  if (!isAuthenticated) {
    return <Redirect href="/login" />;
  }

  if (loading && !chargerData) {
    return <DashboardSkeleton isSingleGun={is30kW} />;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header: Station ID & Unified Minimal Status Badge */}
      <View style={styles.header}>
        <Text style={styles.stationId}>{CHARGER_ID.toUpperCase()}</Text>
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
      {displaySoc !== null && (
        <View style={styles.batteryHeroCard}>
          <View style={styles.batteryHeroTopRow}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={[styles.statusDot, { backgroundColor: isActivelyChargingNow ? '#10B981' : '#64748B', width: 6, height: 6, borderRadius: 3, marginRight: 0 }]} />
                  <Text style={styles.batteryHeroTitle}>
                    {isActivelyChargingNow ? 'CHARGING' : 'BATTERY'}
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
                {isActivelyChargingNow
                  ? 'Charging session in progress'
                  : lastCompletedTx?.socStart
                  ? `Session gain: ${lastCompletedTx.socStart}% → ${displaySoc}% (+${Math.max(0, displaySoc - lastCompletedTx.socStart)}%)`
                  : 'Ready'}
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* Power & Live Cost (PKR Below Amount) */}
      <View style={styles.powerSection}>
        {hasAnyGunConnected ? (
          <View style={styles.priceHeroColumn}>
            <Text style={styles.priceHeroVal}>{totalCost}</Text>
            <Text style={styles.priceHeroCurr}>{curr}</Text>
          </View>
        ) : lastSessionKwh > 0 ? (
          <View style={styles.priceHeroColumn}>
            <Text style={styles.priceHeroVal}>{lastSessionCost > 0 ? lastSessionCost.toLocaleString() : Number(lastSessionKwh).toFixed(2)}</Text>
            <Text style={styles.priceHeroCurr}>{lastSessionCost > 0 ? `${curr} (last session)` : 'kWh delivered (last session)'}</Text>
          </View>
        ) : (
          <View style={styles.powerRow}>
            <Text style={styles.powerValue}>0.0</Text>
            <Text style={styles.powerUnit}>kW</Text>
          </View>
        )}
      </View>

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
              <Text style={styles.metricValue}>{isGunAConnected ? currentA : 0} A</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.metricItem}>
              <Text style={styles.metricLabel}>VOLTAGE</Text>
              <Text style={styles.metricValue}>{voltageA} V</Text>
            </View>
          </View>
        </View>
      ) : bothConnected ? (
        /* Dual Gun View: Both Gun A and Gun B Connected */
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

            <Text style={styles.gunPower}>{Number(powerA).toFixed(1)} kW</Text>

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

            <Text style={styles.gunPower}>{Number(powerB).toFixed(1)} kW</Text>

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
      ) : isGunBConnected ? (
        /* Single Gun B Connected */
        <View style={styles.singleContainer}>
          <View style={styles.singleGunHeader}>
            <View style={[styles.gunDot, { backgroundColor: themeB.color }]} />
            <Text style={styles.gunTitle}>GUN B</Text>
            <View style={[styles.miniStatusPill, { backgroundColor: themeB.bg, marginLeft: 8 }]}>
              <Text style={[styles.miniStatusText, { color: themeB.color }]}>{themeB.label}</Text>
            </View>
            {tel2?.soc ? (
              <View style={{ marginLeft: 'auto', backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#0F172A' }}>{tel2.soc}%</Text>
              </View>
            ) : null}
          </View>

          <View style={styles.metricsGrid}>
            <View style={styles.metricItem}>
              <Text style={styles.metricLabel}>ENERGY</Text>
              <Text style={styles.metricValue}>{energyB} kWh</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.metricItem}>
              <Text style={styles.metricLabel}>POWER</Text>
              <Text style={styles.metricValue}>{Number(powerB).toFixed(1)} kW</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.metricItem}>
              <Text style={styles.metricLabel}>CURRENT</Text>
              <Text style={styles.metricValue}>{isGunBConnected ? currentB : 0} A</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.metricItem}>
              <Text style={styles.metricLabel}>VOLTAGE</Text>
              <Text style={styles.metricValue}>{voltageB} V</Text>
            </View>
          </View>
        </View>
      ) : isGunAConnected ? (
        /* Single Gun A Connected */
        <View style={styles.singleContainer}>
          <View style={styles.singleGunHeader}>
            <View style={[styles.gunDot, { backgroundColor: themeA.color }]} />
            <Text style={styles.gunTitle}>GUN A</Text>
            <View style={[styles.miniStatusPill, { backgroundColor: themeA.bg, marginLeft: 8 }]}>
              <Text style={[styles.miniStatusText, { color: themeA.color }]}>{themeA.label}</Text>
            </View>
            {tel1?.soc ? (
              <View style={{ marginLeft: 'auto', backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#0F172A' }}>{tel1.soc}%</Text>
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
              <Text style={styles.metricValue}>{isGunAConnected ? currentA : 0} A</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.metricItem}>
              <Text style={styles.metricLabel}>VOLTAGE</Text>
              <Text style={styles.metricValue}>{voltageA} V</Text>
            </View>
          </View>
        </View>
      ) : (
        /* Standby: Neither Connected */
        <View style={styles.metricsGrid}>
          <View style={styles.metricItem}>
            <Text style={styles.metricLabel}>LAST SESSION</Text>
            <Text style={styles.metricValue}>
              {lastSessionKwh > 0
                ? `${lastSessionKwh.toFixed(2)} kWh`
                : '0.00 kWh'}
            </Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.metricItem}>
            <Text style={styles.metricLabel}>TOTAL COST</Text>
            <Text style={[styles.metricValue, { color: '#0284C7', fontWeight: '900' }]}>
              {lastSessionCost > 0
                ? `PKR ${lastSessionCost.toLocaleString()}`
                : 'PKR 0'}
            </Text>
          </View>
          {lastDurationText ? (
            <>
              <View style={styles.divider} />
              <View style={styles.metricItem}>
                <Text style={styles.metricLabel}>DURATION</Text>
                <Text style={styles.metricValue}>{lastDurationText}</Text>
              </View>
            </>
          ) : null}
          <View style={styles.divider} />
          <View style={styles.metricItem}>
            <Text style={styles.metricLabel}>STATUS</Text>
            <Text style={[styles.metricValue, { color: '#059669' }]}>STANDBY</Text>
          </View>
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
