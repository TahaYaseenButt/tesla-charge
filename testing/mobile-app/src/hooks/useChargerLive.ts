import { useState, useEffect } from 'react';
import { subscribeToLiveStatus, apiRequest } from '@/config/api';
import {
  getLocalConnectorData,
  getLocalChargerData,
  saveLocalConnectorData,
  saveLocalChargerData,
} from '@/services/storage';

export interface LiveConnectorData {
  status: string;
  telemetry?: {
    voltage?: number;
    voltageL1?: number;
    voltageL2?: number;
    voltageL3?: number;
    currentL1?: number;
    currentL2?: number;
    currentL3?: number;
    powerKw?: number;
    energyWh?: number;
    energyKwh?: number;
    soc?: number;
    cost?: number;
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

  // 2. Direct Real-Time Server Subscription
  useEffect(() => {
    const unsub = subscribeToLiveStatus(cleanId, (statusRes) => {
      if (!statusRes) return;

      const live = statusRes.live || {};
      const charger = live.charger || {};
      const connectors = live.connectors || [];

      // Determine online state
      const online = statusRes.isConnected || charger.status === 'Online';
      setIsOnline(online);
      if (charger.lastHeartbeat) setLastHeartbeat(charger.lastHeartbeat);

      // Connector 1
      const c1Raw = connectors.find((c: any) => c.connectorId === 1) || {};
      const c1ActiveTx = (live.activeTransaction && live.activeTransaction.connector_id === 1) ? live.activeTransaction : null;
      const c1Data: LiveConnectorData = {
        status: c1Raw.status || (c1ActiveTx ? 'Charging' : 'Available'),
        telemetry: {
          voltage: c1Raw.telemetry?.voltage || 0,
          voltageL1: c1Raw.telemetry?.voltageL1 || c1Raw.telemetry?.voltage || 0,
          voltageL2: c1Raw.telemetry?.voltageL2 || 0,
          voltageL3: c1Raw.telemetry?.voltageL3 || 0,
          currentL1: c1Raw.telemetry?.currentL1 || 0,
          powerKw: c1Raw.telemetry?.powerKw || 0,
          energyWh: c1Raw.telemetry?.energyWh || 0,
          energyKwh: c1Raw.telemetry?.energyKwh || 0,
          soc: c1Raw.telemetry?.soc || 0,
          cost: c1Raw.telemetry?.cost || (c1ActiveTx?.cost || 0),
        },
        activeTx: c1ActiveTx,
      };
      setConnector1(c1Data);
      saveLocalConnectorData(cleanId, '1', c1Data);

      // Connector 2
      const c2Raw = connectors.find((c: any) => c.connectorId === 2) || {};
      const c2ActiveTx = (live.activeTransaction && live.activeTransaction.connector_id === 2) ? live.activeTransaction : null;
      const c2Data: LiveConnectorData = {
        status: c2Raw.status || (c2ActiveTx ? 'Charging' : 'Available'),
        telemetry: {
          voltage: c2Raw.telemetry?.voltage || 0,
          voltageL1: c2Raw.telemetry?.voltageL1 || c2Raw.telemetry?.voltage || 0,
          voltageL2: c2Raw.telemetry?.voltageL2 || 0,
          voltageL3: c2Raw.telemetry?.voltageL3 || 0,
          currentL1: c2Raw.telemetry?.currentL1 || 0,
          powerKw: c2Raw.telemetry?.powerKw || 0,
          energyWh: c2Raw.telemetry?.energyWh || 0,
          energyKwh: c2Raw.telemetry?.energyKwh || 0,
          soc: c2Raw.telemetry?.soc || 0,
          cost: c2Raw.telemetry?.cost || (c2ActiveTx?.cost || 0),
        },
        activeTx: c2ActiveTx,
      };
      setConnector2(c2Data);
      saveLocalConnectorData(cleanId, '2', c2Data);

      saveLocalChargerData(cleanId, {
        status: online ? 'Online' : 'Offline',
        lastHeartbeat: charger.lastHeartbeat,
      });

      setLoading(false);
    });

    return () => {
      unsub();
    };
  }, [cleanId]);

  const CONNECTED_STATUSES = ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'];
  const isGunAConnected = CONNECTED_STATUSES.includes(connector1.status);
  const isGunBConnected = CONNECTED_STATUSES.includes(connector2.status);
  const hasAnyGunConnected = isGunAConnected || isGunBConnected;
  const bothConnected = isGunAConnected && isGunBConnected;

  return {
    isOnline,
    lastHeartbeat,
    connector1,
    connector2,
    isGunAConnected,
    isGunBConnected,
    hasAnyGunConnected,
    bothConnected,
    serverTimeOffset,
    loading,
  };
}
