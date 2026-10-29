import { useState, useEffect } from 'react';
import { ref, onValue } from 'firebase/database';
import { doc, onSnapshot, collection, query, where, limit } from 'firebase/firestore';
import { db, rtdb, livePath } from '@/config/firebase';
import {
  getLocalConnectorData,
  getLocalChargerData,
} from '@/services/storage';
import { useSimulator } from '@/config/simulator';

const CONNECTED_STATUSES = [
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
];

export interface LiveConnectorData {
  status: string;
  telemetry?: {
    voltage?: number;
    voltageL1?: number;
    currentL1?: number;
    powerKw?: number;
    energyWh?: number;
    energyKwh?: number;
    soc?: number;
  };
  activeTx?: any;
}

export function useChargerLive(chargerId: string) {
  const cleanId = chargerId?.trim().toLowerCase() || 'charger1';

  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [lastHeartbeat, setLastHeartbeat] = useState<string | null>(null);
  const [connector1, setConnector1] = useState<LiveConnectorData>({ status: 'Available' });
  const [connector2, setConnector2] = useState<LiveConnectorData>({ status: 'Available' });
  const [serverTimeOffset, setServerTimeOffset] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);

  // 1. Initial 0ms Local Storage fetch
  useEffect(() => {
    getLocalChargerData(cleanId).then((c) => {
      if (c?.status) setIsOnline(c.status === 'Online');
      if (c?.lastHeartbeat) setLastHeartbeat(c.lastHeartbeat);
    });
    getLocalConnectorData(cleanId, '1').then((c1) => {
      if (c1?.status) setConnector1((prev) => ({ ...prev, ...c1 }));
    });
    getLocalConnectorData(cleanId, '2').then((c2) => {
      if (c2?.status) setConnector2((prev) => ({ ...prev, ...c2 }));
    });
  }, [cleanId]);

  // 2. Server time offset (safe RTDB listener)
  useEffect(() => {
    try {
      const offsetRef = ref(rtdb, '.info/serverTimeOffset');
      const unsub = onValue(
        offsetRef,
        (snap) => {
          setServerTimeOffset(snap.val() || 0);
        },
        () => {}
      );
      return () => unsub();
    } catch {}
  }, []);

  // 3. Firestore Real-Time listeners (100% resilient fallback if RTDB rules block access)
  useEffect(() => {
    // Station doc
    const unsubCharger = onSnapshot(
      doc(db, 'chargers', cleanId),
      (snap) => {
        if (snap.exists()) {
          const d = snap.data();
          if (d.status) setIsOnline(d.status === 'Online');
          if (d.lastHeartbeat) setLastHeartbeat(d.lastHeartbeat);

          // If connector status summary is embedded in charger doc
          if (d.connector_1_status) {
            setConnector1((prev) => ({ ...prev, status: d.connector_1_status }));
          }
          if (d.connector_2_status) {
            setConnector2((prev) => ({ ...prev, status: d.connector_2_status }));
          }
          setLoading(false);
        }
      },
      () => {
        setLoading(false);
      }
    );

    // Connector 1 doc
    const unsubConn1 = onSnapshot(
      doc(db, 'chargers', cleanId, 'connectors', '1'),
      (snap) => {
        if (snap.exists()) {
          const c1 = snap.data();
          const hasActive1 = c1.status === 'Charging' || c1.status === 'Finishing';
          setConnector1((prev) => ({
            status: c1.status || prev.status || 'Available',
            telemetry: c1.telemetry || prev.telemetry || {},
            activeTx: hasActive1 ? (c1.activeTx || prev.activeTx || null) : null,
          }));
          setLoading(false);
        }
      },
      () => {}
    );

    // Connector 2 doc
    const unsubConn2 = onSnapshot(
      doc(db, 'chargers', cleanId, 'connectors', '2'),
      (snap) => {
        if (snap.exists()) {
          const c2 = snap.data();
          const hasActive2 = c2.status === 'Charging' || c2.status === 'Finishing';
          setConnector2((prev) => ({
            status: c2.status || prev.status || 'Available',
            telemetry: c2.telemetry || prev.telemetry || {},
            activeTx: hasActive2 ? (c2.activeTx || prev.activeTx || null) : null,
          }));
          setLoading(false);
        }
      },
      () => {}
    );

    // Active transactions from transactions collection
    const qActiveTx = query(
      collection(db, 'transactions'),
      where('chargePointId', '==', cleanId),
      where('status', '==', 'Charging'),
      limit(5)
    );
    const unsubActiveTx = onSnapshot(
      qActiveTx,
      (snap) => {
        if (!snap.empty) {
          snap.docs.forEach((d) => {
            const tx: any = { id: d.id, ...d.data() };
            if (Number(tx.connectorId || 1) === 1) {
              setConnector1((prev) => ({
                ...prev,
                activeTx: { ...(prev.activeTx || {}), ...tx },
              }));
            } else if (Number(tx.connectorId) === 2) {
              setConnector2((prev) => ({
                ...prev,
                activeTx: { ...(prev.activeTx || {}), ...tx },
              }));
            }
          });
        }
      },
      () => {}
    );

    return () => {
      unsubCharger();
      unsubConn1();
      unsubConn2();
      unsubActiveTx();
    };
  }, [cleanId]);

  // 4. Live RTDB listener (for instant WebSocket reactivity when RTDB permissions allow)
  useEffect(() => {
    try {
      const liveRef = ref(rtdb, livePath(cleanId));
      const unsub = onValue(
        liveRef,
        (snap) => {
          setLoading(false);
          const live = snap.val();
          if (!live) return;

          const hb = live.lastHeartbeat || null;
          if (hb) setLastHeartbeat(hb);

          // Heartbeat check
          const nowServer = Date.now() + serverTimeOffset;
          const lastHbTime = hb ? new Date(hb).getTime() : 0;
          const hasRecentHb = lastHbTime > 0 ? nowServer - lastHbTime < 180000 : true;
          const online = (live.status === 'Online' || !live.status) && hasRecentHb;
          setIsOnline(online);

          const c1 = live.connectors?.['1'] || (Array.isArray(live.connectors) ? live.connectors[1] : null);
          const c2 = live.connectors?.['2'] || (Array.isArray(live.connectors) ? live.connectors[2] : null);
          const active1 = live.activeTx?.['1'] || (Array.isArray(live.activeTx) ? live.activeTx[1] : null);
          const active2 = live.activeTx?.['2'] || (Array.isArray(live.activeTx) ? live.activeTx[2] : null);

          if (c1) {
            const hasTx1 = (active1 && (active1.status === 'Charging' || active1.status === 'Finishing')) ||
              (c1.activeTx && (c1.activeTx.status === 'Charging' || c1.activeTx.status === 'Finishing'));
            setConnector1((prev) => ({
              status: c1.status || 'Available',
              telemetry: c1.telemetry || prev.telemetry || {},
              activeTx: hasTx1 ? (active1 || c1.activeTx || prev.activeTx || null) : null,
            }));
          }

          if (c2) {
            const hasTx2 = (active2 && (active2.status === 'Charging' || active2.status === 'Finishing')) ||
              (c2.activeTx && (c2.activeTx.status === 'Charging' || c2.activeTx.status === 'Finishing'));
            setConnector2((prev) => ({
              status: c2.status || 'Available',
              telemetry: c2.telemetry || prev.telemetry || {},
              activeTx: hasTx2 ? (active2 || c2.activeTx || prev.activeTx || null) : null,
            }));
          }
        },
        () => {
          // RTDB permission denied or unavailable -> gracefully fallback to Firestore snapshot
          setLoading(false);
        }
      );

      return () => unsub();
    } catch {
      setLoading(false);
    }
  }, [cleanId, serverTimeOffset]);

  // Simulator integration for testing UI without plugging into a physical car
  const { isSimulating, gunA: simA, gunB: simB } = useSimulator();

  const effectiveConn1: LiveConnectorData = isSimulating
    ? {
        status: simA.status,
        telemetry: {
          voltage: simA.voltage,
          currentL1: simA.current,
          powerKw: simA.powerKw,
          energyKwh: simA.energyKwh,
          soc: simA.soc,
        },
        activeTx: simA.status === 'Charging' ? {
          energyDeliveredKwh: simA.energyKwh,
          cost: simA.cost,
          socStart: simA.soc > 5 ? simA.soc - 5 : simA.soc,
          socCurrent: simA.soc,
        } : null,
      }
    : connector1;

  const effectiveConn2: LiveConnectorData = isSimulating
    ? {
        status: simB.status,
        telemetry: {
          voltage: simB.voltage,
          currentL1: simB.current,
          powerKw: simB.powerKw,
          energyKwh: simB.energyKwh,
          soc: simB.soc,
        },
        activeTx: simB.status === 'Charging' ? {
          energyDeliveredKwh: simB.energyKwh,
          cost: simB.cost,
          socStart: simB.soc > 5 ? simB.soc - 5 : simB.soc,
          socCurrent: simB.soc,
        } : null,
      }
    : connector2;

  // A gun is connected if its status is in CONNECTED_STATUSES
  const isGunAConnected = CONNECTED_STATUSES.includes(effectiveConn1.status);
  const isGunBConnected = CONNECTED_STATUSES.includes(effectiveConn2.status);
  const hasAnyGunConnected = isGunAConnected || isGunBConnected;
  const bothConnected = isGunAConnected && isGunBConnected;

  return {
    isOnline: isSimulating ? true : isOnline,
    lastHeartbeat,
    connector1: effectiveConn1,
    connector2: effectiveConn2,
    isGunAConnected,
    isGunBConnected,
    hasAnyGunConnected,
    bothConnected,
    loading: isSimulating ? false : loading,
    serverTimeOffset,
  };
}
