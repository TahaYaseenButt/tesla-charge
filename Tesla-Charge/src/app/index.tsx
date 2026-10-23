import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
  Image,
} from 'react-native';
import { doc, onSnapshot, collection, addDoc, query, where, limit } from 'firebase/firestore';
import { db } from '@/config/firebase';

const CHARGER_ID = 'charger01'; // Default charger ID matching your Voltronic charger

// 4 State Images from your design
const STATE_IMAGES = {
  idle: require('@/assets/images/states/state_idle.png'),
  left: require('@/assets/images/states/state_left.png'),
  right: require('@/assets/images/states/state_right.png'),
  both: require('@/assets/images/states/state_both.png'),
};

type CarState = 'idle' | 'left' | 'right' | 'both';

export default function HomeScreen() {
  const [chargerData, setChargerData] = useState<any>(null);
  const [connector1Data, setConnector1Data] = useState<any>(null);
  const [connector2Data, setConnector2Data] = useState<any>(null);
  const [activeTxData, setActiveTxData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Manual state override for preview testing (or 'auto' for live charger sync)
  const [stateMode, setStateMode] = useState<'auto' | CarState>('auto');

  // 1. Listen to the Charger document in real-time
  useEffect(() => {
    const chargerRef = doc(db, 'chargers', CHARGER_ID);
    const unsubCharger = onSnapshot(chargerRef, (docSnap) => {
      if (docSnap.exists()) {
        setChargerData(docSnap.data());
      } else {
        setChargerData(null);
      }
      setLoading(false);
    });

    // 2. Listen to Connector 1 (Left Gun)
    const conn1Ref = doc(db, 'chargers', CHARGER_ID, 'connectors', '1');
    const unsubConn1 = onSnapshot(conn1Ref, (docSnap) => {
      if (docSnap.exists()) {
        setConnector1Data(docSnap.data());
      } else {
        setConnector1Data(null);
      }
    });

    // 3. Listen to Connector 2 (Right Gun)
    const conn2Ref = doc(db, 'chargers', CHARGER_ID, 'connectors', '2');
    const unsubConn2 = onSnapshot(conn2Ref, (docSnap) => {
      if (docSnap.exists()) {
        setConnector2Data(docSnap.data());
      } else {
        setConnector2Data(null);
      }
    });

    // 4. Listen for any active transaction
    const txQuery = query(
      collection(db, 'transactions'),
      where('chargePointId', '==', CHARGER_ID),
      where('status', '==', 'Charging'),
      limit(1)
    );
    const unsubTx = onSnapshot(txQuery, (querySnap) => {
      if (!querySnap.empty) {
        setActiveTxData(querySnap.docs[0].data());
      } else {
        setActiveTxData(null);
      }
    });

    return () => {
      unsubCharger();
      unsubConn1();
      unsubConn2();
      unsubTx();
    };
  }, []);

  // Compute car state dynamically from live connector statuses
  const status1 = connector1Data?.status || 'Available';
  const status2 = connector2Data?.status || 'Available';

  const isLeftConnected = status1 === 'Charging' || status1 === 'Preparing' || status1 === 'SuspendedEV';
  const isRightConnected = status2 === 'Charging' || status2 === 'Preparing' || status2 === 'SuspendedEV';

  let autoState: CarState = 'idle';
  if (isLeftConnected && isRightConnected) {
    autoState = 'both';
  } else if (isLeftConnected) {
    autoState = 'left';
  } else if (isRightConnected) {
    autoState = 'right';
  }

  // Active state to render (uses manual override if selected, else auto)
  const activeState: CarState = stateMode === 'auto' ? autoState : stateMode;

  const stateTitles: Record<CarState, string> = {
    idle: '1 • Charger Idle',
    left: '2 • Car on Left Side',
    right: '3 • Car on Right Side',
    both: '4 • Car on Both Sides',
  };

  const isOnline = chargerData?.status === 'Online';
  const isCharging = activeState !== 'idle';

  // Live telemetry metrics
  const power1 = connector1Data?.telemetry?.powerKw || 0;
  const power2 = connector2Data?.telemetry?.powerKw || 0;
  const totalPower = (power1 + power2) > 0 ? (power1 + power2) : (isCharging ? 7.4 : 0);
  const voltage = connector1Data?.telemetry?.voltage || 230;
  const current = connector1Data?.telemetry?.currentL1 || (isCharging ? 32.1 : 0);
  const energyKwh = activeTxData?.energyDeliveredKwh || ((connector1Data?.telemetry?.energyWh || 0) / 1000).toFixed(1);

  const sendCommand = async (action: string, connectorId: number = 1, extraParams: any = {}) => {
    try {
      setActionLoading(`${action}_${connectorId}`);
      await addDoc(collection(db, 'commands'), {
        chargePointId: CHARGER_ID,
        action,
        connectorId,
        status: 'pending',
        createdAt: new Date().toISOString(),
        ...extraParams,
      });

      const successMsg =
        action === 'UnlockConnector'
          ? `Unlock command sent to Cable #${connectorId}!`
          : action === 'RemoteStopTransaction'
          ? 'Stop charging command sent!'
          : 'Command sent successfully!';

      if (Platform.OS === 'web') {
        alert(successMsg);
      } else {
        Alert.alert('Success', successMsg);
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Failed to send command';
      if (Platform.OS === 'web') {
        alert(errMsg);
      } else {
        Alert.alert('Error', errMsg);
      }
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#0284C7" />
        <Text style={styles.loadingText}>Loading Tesla Charge...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Top Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.brandTitle}>⚡ TESLA CHARGE</Text>
          <Text style={styles.stationSubtitle}>Station: {CHARGER_ID.toUpperCase()}</Text>
        </View>
        <View style={[styles.statusBadge, isOnline ? styles.onlineBadge : styles.offlineBadge]}>
          <View style={[styles.statusDot, isOnline ? styles.onlineDot : styles.offlineDot]} />
          <Text style={[styles.statusBadgeText, isOnline ? styles.onlineText : styles.offlineText]}>
            {isOnline ? 'ONLINE' : 'OFFLINE'}
          </Text>
        </View>
      </View>

      {/* 3D Visualizer Card with Your 4 State Images */}
      <View style={styles.visualizerCard}>
        <View style={styles.visualizerHeader}>
          <Text style={styles.stateTag}>{stateTitles[activeState]}</Text>
          <View style={styles.liveIndicator}>
            <View style={[styles.liveDot, isCharging ? styles.chargingDot : styles.idleDot]} />
            <Text style={styles.liveIndicatorText}>{isCharging ? 'CHARGING' : 'STANDBY'}</Text>
          </View>
        </View>

        {/* The Selected State Image */}
        <View style={styles.imageWrapper}>
          <Image
            source={STATE_IMAGES[activeState]}
            style={styles.stateImage}
            resizeMode="contain"
          />
        </View>

        {/* State Preview Switcher Tabs */}
        <View style={styles.modeTabsRow}>
          <TouchableOpacity
            style={[styles.modeTab, stateMode === 'auto' && styles.activeModeTab]}
            onPress={() => setStateMode('auto')}
          >
            <Text style={[styles.modeTabText, stateMode === 'auto' && styles.activeModeTabText]}>
              Auto (Live)
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, stateMode === 'idle' && styles.activeModeTab]}
            onPress={() => setStateMode('idle')}
          >
            <Text style={[styles.modeTabText, stateMode === 'idle' && styles.activeModeTabText]}>
              1. Idle
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, stateMode === 'left' && styles.activeModeTab]}
            onPress={() => setStateMode('left')}
          >
            <Text style={[styles.modeTabText, stateMode === 'left' && styles.activeModeTabText]}>
              2. Left
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, stateMode === 'right' && styles.activeModeTab]}
            onPress={() => setStateMode('right')}
          >
            <Text style={[styles.modeTabText, stateMode === 'right' && styles.activeModeTabText]}>
              3. Right
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, stateMode === 'both' && styles.activeModeTab]}
            onPress={() => setStateMode('both')}
          >
            <Text style={[styles.modeTabText, stateMode === 'both' && styles.activeModeTabText]}>
              4. Both
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Live Power Output Card */}
      <View style={styles.powerCard}>
        <View style={styles.powerTopRow}>
          <Text style={styles.powerCardLabel}>TOTAL POWER DELIVERY</Text>
          {isCharging && (
            <View style={styles.chargingBadge}>
              <Text style={styles.chargingBadgeText}>ACTIVE SESSION</Text>
            </View>
          )}
        </View>

        <View style={styles.powerNumberRow}>
          <Text style={[styles.powerNumber, isCharging ? styles.powerNumberActive : null]}>
            {totalPower.toFixed(1)}
          </Text>
          <Text style={styles.powerUnit}>kW</Text>
        </View>

        {/* Metrics Grid (Voltage, Current, Energy) */}
        <View style={styles.metricsGrid}>
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>VOLTAGE</Text>
            <Text style={styles.metricValue}>{voltage} V</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>CURRENT</Text>
            <Text style={styles.metricValue}>{current} A</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>ENERGY</Text>
            <Text style={styles.metricValue}>{energyKwh} kWh</Text>
          </View>
        </View>
      </View>

      {/* Dual Connector Details (Left Gun & Right Gun) */}
      <View style={styles.connectorsRow}>
        {/* Left Connector #1 */}
        <View style={[styles.connectorCard, isLeftConnected && styles.connectorCardActive]}>
          <View style={styles.connectorHeader}>
            <Text style={styles.connectorTitle}>LEFT GUN (C1)</Text>
            <View style={[styles.pill, isLeftConnected ? styles.pillCharging : styles.pillAvailable]}>
              <Text style={[styles.pillText, isLeftConnected ? styles.pillChargingText : styles.pillAvailableText]}>
                {status1.toUpperCase()}
              </Text>
            </View>
          </View>
          <Text style={styles.connectorPower}>{power1.toFixed(1)} kW</Text>
          <TouchableOpacity
            style={styles.gunUnlockBtn}
            disabled={actionLoading !== null}
            onPress={() => sendCommand('UnlockConnector', 1)}
          >
            {actionLoading === 'UnlockConnector_1' ? (
              <ActivityIndicator size="small" color="#0284C7" />
            ) : (
              <Text style={styles.gunUnlockBtnText}>🔓 Unlock Left</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Right Connector #2 */}
        <View style={[styles.connectorCard, isRightConnected && styles.connectorCardActive]}>
          <View style={styles.connectorHeader}>
            <Text style={styles.connectorTitle}>RIGHT GUN (C2)</Text>
            <View style={[styles.pill, isRightConnected ? styles.pillCharging : styles.pillAvailable]}>
              <Text style={[styles.pillText, isRightConnected ? styles.pillChargingText : styles.pillAvailableText]}>
                {status2.toUpperCase()}
              </Text>
            </View>
          </View>
          <Text style={styles.connectorPower}>{power2.toFixed(1)} kW</Text>
          <TouchableOpacity
            style={styles.gunUnlockBtn}
            disabled={actionLoading !== null}
            onPress={() => sendCommand('UnlockConnector', 2)}
          >
            {actionLoading === 'UnlockConnector_2' ? (
              <ActivityIndicator size="small" color="#0284C7" />
            ) : (
              <Text style={styles.gunUnlockBtnText}>🔓 Unlock Right</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Quick Action Controls */}
      <View style={styles.controlsCard}>
        <Text style={styles.cardSectionLabel}>STATION ACTIONS</Text>

        <View style={styles.actionsGrid}>
          {isCharging ? (
            <TouchableOpacity
              style={styles.stopButton}
              disabled={actionLoading !== null}
              onPress={() =>
                sendCommand('RemoteStopTransaction', 1, {
                  transactionId: activeTxData?.transactionId,
                })
              }
            >
              <Text style={styles.stopButtonText}>⏹️ STOP CHARGING</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.startButton}
              disabled={actionLoading !== null}
              onPress={() => sendCommand('RemoteStartTransaction', 1)}
            >
              <Text style={styles.startButtonText}>⚡ START CHARGING</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.rebootButton}
            disabled={actionLoading !== null}
            onPress={() => sendCommand('Reset', 1, { type: 'Soft' })}
          >
            <Text style={styles.rebootButtonText}>🔄 REBOOT</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Station Hardware Specs */}
      <View style={styles.specsCard}>
        <Text style={styles.cardSectionLabel}>HARDWARE SPECIFICATIONS</Text>
        <View style={styles.specRow}>
          <Text style={styles.specKey}>Station Model</Text>
          <Text style={styles.specVal}>{chargerData?.model || 'Solar EVX / Voltronic'}</Text>
        </View>
        <View style={styles.specRow}>
          <Text style={styles.specKey}>Vendor</Text>
          <Text style={styles.specVal}>{chargerData?.vendor || 'Voltronic Power'}</Text>
        </View>
        <View style={styles.specRow}>
          <Text style={styles.specKey}>Firmware</Text>
          <Text style={styles.specVal}>{chargerData?.firmwareVersion || 'v2.1.4'}</Text>
        </View>
        <View style={styles.specRow}>
          <Text style={styles.specKey}>OCPP Protocol</Text>
          <Text style={styles.specVal}>OCPP 1.6-J (JSON / WebSocket)</Text>
        </View>
      </View>

      <View style={{ height: 100 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  content: {
    padding: 18,
    paddingTop: Platform.OS === 'ios' ? 60 : 36,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 14,
    color: '#64748B',
    fontSize: 14,
    fontWeight: '600',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  brandTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: 1,
  },
  stationSubtitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 2,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  onlineBadge: {
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
  },
  offlineBadge: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  onlineDot: {
    backgroundColor: '#10B981',
  },
  offlineDot: {
    backgroundColor: '#EF4444',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  onlineText: {
    color: '#065F46',
  },
  offlineText: {
    color: '#991B1B',
  },
  visualizerCard: {
    backgroundColor: 'transparent',
    paddingVertical: 4,
    marginBottom: 14,
    alignItems: 'center',
  },
  visualizerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  stateTag: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A',
  },
  liveIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 5,
  },
  chargingDot: {
    backgroundColor: '#10B981',
  },
  idleDot: {
    backgroundColor: '#94A3B8',
  },
  liveIndicatorText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#475569',
  },
  imageWrapper: {
    width: '100%',
    height: 230,
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 4,
  },
  stateImage: {
    width: '100%',
    height: '100%',
  },
  modeTabsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: 10,
    backgroundColor: '#F8FAFC',
    borderRadius: 14,
    padding: 3,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  modeTab: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 9,
  },
  activeModeTab: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 1,
  },
  modeTabText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
  },
  activeModeTabText: {
    color: '#0284C7',
    fontWeight: '800',
  },
  powerCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.04,
    shadowRadius: 10,
    elevation: 2,
    marginBottom: 16,
  },
  powerTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  powerCardLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 1,
  },
  chargingBadge: {
    backgroundColor: '#ECFDF5',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  chargingBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#059669',
  },
  powerNumberRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginVertical: 10,
  },
  powerNumber: {
    fontSize: 56,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -1.5,
  },
  powerNumberActive: {
    color: '#059669',
  },
  powerUnit: {
    fontSize: 22,
    fontWeight: '800',
    color: '#64748B',
    marginLeft: 6,
  },
  metricsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingTop: 14,
    marginTop: 6,
  },
  metricBox: {
    alignItems: 'center',
  },
  metricDivider: {
    width: 1,
    height: '100%',
    backgroundColor: '#F1F5F9',
  },
  metricLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  metricValue: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
  },
  connectorsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  connectorCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 6,
    elevation: 2,
  },
  connectorCardActive: {
    borderColor: '#A7F3D0',
    backgroundColor: '#F0FDF4',
  },
  connectorHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  connectorTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#475569',
    letterSpacing: 0.5,
  },
  pill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  pillAvailable: {
    backgroundColor: '#F1F5F9',
  },
  pillCharging: {
    backgroundColor: '#DCFCE7',
  },
  pillText: {
    fontSize: 8,
    fontWeight: '800',
  },
  pillAvailableText: {
    color: '#475569',
  },
  pillChargingText: {
    color: '#15803D',
  },
  connectorPower: {
    fontSize: 20,
    fontWeight: '900',
    color: '#0F172A',
    marginBottom: 10,
  },
  gunUnlockBtn: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: 'center',
  },
  gunUnlockBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0284C7',
  },
  controlsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 16,
  },
  cardSectionLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 1,
    marginBottom: 12,
  },
  actionsGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  startButton: {
    flex: 2,
    backgroundColor: '#0284C7',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#0284C7',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 3,
  },
  startButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  stopButton: {
    flex: 2,
    backgroundColor: '#EF4444',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#EF4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 3,
  },
  stopButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  rebootButton: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  rebootButtonText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '700',
  },
  specsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  specRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#F8FAFC',
  },
  specKey: {
    fontSize: 12,
    color: '#64748B',
  },
  specVal: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0F172A',
  },
});
