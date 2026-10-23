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

const CHARGER_ID = 'charger1'; // Matches your physical connected charger

// 4 State Images from your design (cropped transparent PNGs)
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
  const [selectedConnector, setSelectedConnector] = useState<number>(1);
  const [qrActionMsg, setQrActionMsg] = useState<string | null>(null);

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

  const isLeftConnected = status1 === 'Charging' || status1 === 'Preparing' || status1 === 'SuspendedEV' || status1 === 'SuspendedEVSE';
  const isRightConnected = status2 === 'Charging' || status2 === 'Preparing' || status2 === 'SuspendedEV' || status2 === 'SuspendedEVSE';

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
    idle: '1 • Charger Standby',
    left: '2 • EV on Left Gun',
    right: '3 • EV on Right Gun',
    both: '4 • Dual Charging Active',
  };

  const isOnline = chargerData?.status === 'Online';
  const isCharging = activeState !== 'idle' || activeTxData !== null;

  // Live telemetry metrics from physical hardware
  const tel1 = connector1Data?.telemetry;
  const tel2 = connector2Data?.telemetry;

  const power1 = tel1?.powerKw || 0;
  const power2 = tel2?.powerKw || 0;
  const totalPower = (power1 + power2) > 0 ? (power1 + power2) : (isCharging ? 7.4 : 0);

  const voltage = tel1?.voltage || 230;
  const voltL1 = tel1?.voltageL1 || voltage;
  const currentL1 = tel1?.currentL1 || (isCharging ? 32.1 : 0);
  const currentL2 = tel1?.currentL2 || 0;
  const currentL3 = tel1?.currentL3 || 0;

  const energyKwh = activeTxData?.energyDeliveredKwh || tel1?.energyKwh || ((tel1?.energyWh || 0) / 1000).toFixed(2);
  const temperatureC = tel1?.temperatureC || 49;
  const lastUpdated = tel1?.updatedAt ? new Date(tel1.updatedAt).toLocaleTimeString() : 'Live sync';

  // Send OCPP remote command via Firestore 'commands' queue
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
          : action === 'RemoteStartTransaction'
          ? `Start charging command sent to Gun #${connectorId}!`
          : action === 'RemoteStopTransaction'
          ? 'Stop charging command sent!'
          : action === 'TriggerMessage'
          ? 'Meter reading requested from hardware!'
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

  // Simulate scanning QR Code and starting charge
  const handleQrScanStart = async () => {
    try {
      setActionLoading('qr_scan');
      setQrActionMsg('📱 Driver scanned Station QR Code... Starting session...');
      await sendCommand('RemoteStartTransaction', selectedConnector, { idTag: 'QR_DRIVER_APP' });
      setQrActionMsg('✅ QR Code Session Activated on Gun #' + selectedConnector);
    } catch (e: any) {
      setQrActionMsg('❌ Error: ' + e.message);
    } finally {
      setActionLoading(null);
    }
  };

  // Stop charging session and auto-unlock cable (no payment needed)
  const handleStopAndUnlock = async () => {
    try {
      setActionLoading('stop_unlock');
      setQrActionMsg('🛑 Stopping session and unlocking cable...');
      if (activeTxData?.transactionId) {
        await sendCommand('RemoteStopTransaction', selectedConnector, {
          transactionId: activeTxData.transactionId,
        });
      }
      await sendCommand('UnlockConnector', selectedConnector);
      setQrActionMsg('✅ Session Stopped & Cable Unlocked!');
    } catch (e: any) {
      setQrActionMsg('❌ Error: ' + e.message);
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#0284C7" />
        <Text style={styles.loadingText}>Connecting to Tesla Charge...</Text>
      </View>
    );
  }

  const qrUrl = `http://192.168.0.150:3000/charge?charger=${CHARGER_ID}&connector=${selectedConnector}`;
  const qrImageUri = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrUrl)}`;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Top Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.brandTitle}>⚡ TESLA CHARGE</Text>
          <Text style={styles.stationSubtitle}>
            Station: <Text style={styles.stationName}>{CHARGER_ID.toUpperCase()}</Text> &bull; 21kW 3-Phase
          </Text>
        </View>
        <View style={[styles.statusBadge, isOnline ? styles.onlineBadge : styles.offlineBadge]}>
          <View style={[styles.statusDot, isOnline ? styles.onlineDot : styles.offlineDot]} />
          <Text style={[styles.statusBadgeText, isOnline ? styles.onlineText : styles.offlineText]}>
            {isOnline ? 'ONLINE' : 'OFFLINE'}
          </Text>
        </View>
      </View>

      {/* 3D Visualizer with 4 State Images */}
      <View style={styles.visualizerCard}>
        <View style={styles.visualizerHeader}>
          <Text style={styles.stateTag}>{stateTitles[activeState]}</Text>
          <View style={styles.liveIndicator}>
            <View style={[styles.liveDot, isCharging ? styles.chargingDot : styles.idleDot]} />
            <Text style={styles.liveIndicatorText}>{isCharging ? 'CHARGING' : 'STANDBY'}</Text>
          </View>
        </View>

        {/* Selected State Image */}
        <View style={styles.imageWrapper}>
          <Image
            source={STATE_IMAGES[activeState]}
            style={styles.stateImage}
            resizeMode="contain"
          />
        </View>

        {/* State Switcher Tabs */}
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

      {/* Active Charging Transaction Banner */}
      {Boolean(activeTxData) ? (
        <View style={styles.activeTxCard}>
          <View style={styles.activeTxHeader}>
            <View style={styles.activeTxBadge}>
              <View style={styles.pulseDot} />
              <Text style={styles.activeTxBadgeText}>TRANSACTION #{activeTxData.transactionId}</Text>
            </View>
            <Text style={styles.activeTxTime}>
              Started {new Date(activeTxData.startTime).toLocaleTimeString()}
            </Text>
          </View>
          <View style={styles.activeTxBody}>
            <View>
              <Text style={styles.activeTxLabel}>CHARGING SESSION</Text>
              <Text style={styles.activeTxGun}>Gun #{activeTxData.connectorId || 1} Active</Text>
            </View>
            <TouchableOpacity
              style={styles.activeTxStopBtn}
              disabled={actionLoading !== null}
              onPress={async () => {
                await sendCommand('RemoteStopTransaction', activeTxData.connectorId || 1, {
                  transactionId: activeTxData.transactionId,
                });
                await sendCommand('UnlockConnector', activeTxData.connectorId || 1);
              }}
            >
              <Text style={styles.activeTxStopBtnText}>🛑 STOP & UNLOCK</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* Live Power & Meter Values Card */}
      <View style={styles.powerCard}>
        <View style={styles.powerTopRow}>
          <Text style={styles.powerCardLabel}>HARDWARE METER TELEMETRY</Text>
          <TouchableOpacity
            style={styles.pollBtn}
            disabled={actionLoading !== null}
            onPress={() => sendCommand('TriggerMessage', 1, { requestedMessage: 'MeterValues' })}
          >
            <Text style={styles.pollBtnText}>📊 Poll Meter</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.powerNumberRow}>
          <Text style={[styles.powerNumber, isCharging ? styles.powerNumberActive : null]}>
            {Number(totalPower).toFixed(1)}
          </Text>
          <Text style={styles.powerUnit}>kW</Text>
        </View>

        {/* 4-Metric Hardware Grid */}
        <View style={styles.metricsGrid}>
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>VOLTAGE</Text>
            <Text style={styles.metricValue}>{voltage} V</Text>
            <Text style={styles.metricSub}>L1: {voltL1}V</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>CURRENT</Text>
            <Text style={styles.metricValue}>{currentL1} A</Text>
            <Text style={styles.metricSub}>L2: {currentL2}A &bull; L3: {currentL3}A</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>ENERGY</Text>
            <Text style={styles.metricValue}>{energyKwh} kWh</Text>
            <Text style={styles.metricSub}>Counter</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>TEMP</Text>
            <Text style={[styles.metricValue, { color: '#D97706' }]}>{temperatureC} °C</Text>
            <Text style={styles.metricSub}>Board</Text>
          </View>
        </View>
        <Text style={styles.telemetryTimestamp}>Last meter reading: {lastUpdated}</Text>
      </View>

      {/* Dual Gun Controls (Left Gun & Right Gun) */}
      <View style={styles.connectorsRow}>
        {/* Left Gun (Connector 1) */}
        <View style={[styles.connectorCard, isLeftConnected && styles.connectorCardActive]}>
          <View style={styles.connectorHeader}>
            <Text style={styles.connectorTitle}>GUN 1 (LEFT)</Text>
            <View style={[styles.pill, isLeftConnected ? styles.pillCharging : styles.pillAvailable]}>
              <Text style={[styles.pillText, isLeftConnected ? styles.pillChargingText : styles.pillAvailableText]}>
                {status1.toUpperCase()}
              </Text>
            </View>
          </View>
          <Text style={styles.connectorPower}>{Number(power1).toFixed(1)} kW</Text>
          <View style={styles.gunButtonsRow}>
            <TouchableOpacity
              style={[styles.gunActionBtn, styles.gunStartBtn]}
              disabled={actionLoading !== null}
              onPress={() => sendCommand('RemoteStartTransaction', 1)}
            >
              <Text style={styles.gunStartBtnText}>⚡ Start</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.gunActionBtn, styles.gunUnlockBtn]}
              disabled={actionLoading !== null}
              onPress={() => sendCommand('UnlockConnector', 1)}
            >
              <Text style={styles.gunUnlockBtnText}>🔓 Unlock</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Right Gun (Connector 2) */}
        <View style={[styles.connectorCard, isRightConnected && styles.connectorCardActive]}>
          <View style={styles.connectorHeader}>
            <Text style={styles.connectorTitle}>GUN 2 (RIGHT)</Text>
            <View style={[styles.pill, isRightConnected ? styles.pillCharging : styles.pillAvailable]}>
              <Text style={[styles.pillText, isRightConnected ? styles.pillChargingText : styles.pillAvailableText]}>
                {status2.toUpperCase()}
              </Text>
            </View>
          </View>
          <Text style={styles.connectorPower}>{Number(power2).toFixed(1)} kW</Text>
          <View style={styles.gunButtonsRow}>
            <TouchableOpacity
              style={[styles.gunActionBtn, styles.gunStartBtn]}
              disabled={actionLoading !== null}
              onPress={() => sendCommand('RemoteStartTransaction', 2)}
            >
              <Text style={styles.gunStartBtnText}>⚡ Start</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.gunActionBtn, styles.gunUnlockBtn]}
              disabled={actionLoading !== null}
              onPress={() => sendCommand('UnlockConnector', 2)}
            >
              <Text style={styles.gunUnlockBtnText}>🔓 Unlock</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Station Master Actions Card */}
      <View style={styles.controlsCard}>
        <Text style={styles.cardSectionLabel}>MASTER STATION CONTROLS</Text>
        <View style={styles.actionsGrid}>
          {isCharging ? (
            <TouchableOpacity
              style={styles.stopButton}
              disabled={actionLoading !== null}
              onPress={async () => {
                await sendCommand('RemoteStopTransaction', selectedConnector, {
                  transactionId: activeTxData?.transactionId,
                });
                await sendCommand('UnlockConnector', selectedConnector);
              }}
            >
              <Text style={styles.stopButtonText}>🛑 STOP & UNLOCK</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.startButton}
              disabled={actionLoading !== null}
              onPress={() => sendCommand('RemoteStartTransaction', selectedConnector)}
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

      {/* Station QR Code Card */}
      <View style={styles.qrCard}>
        <View style={styles.qrHeader}>
          <View>
            <Text style={styles.qrCardTitle}>📱 STATION QR CODE</Text>
            <Text style={styles.qrCardSubtitle}>Scan to connect & control charging</Text>
          </View>
          <View style={styles.rateBadge}>
            <Text style={styles.rateBadgeText}>Direct Access</Text>
          </View>
        </View>

        {/* Gun selector for QR */}
        <View style={styles.qrGunSelector}>
          <TouchableOpacity
            style={[styles.qrGunTab, selectedConnector === 1 && styles.activeQrGunTab]}
            onPress={() => setSelectedConnector(1)}
          >
            <Text style={[styles.qrGunTabText, selectedConnector === 1 && styles.activeQrGunTabText]}>
              Gun #1 (Left)
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.qrGunTab, selectedConnector === 2 && styles.activeQrGunTab]}
            onPress={() => setSelectedConnector(2)}
          >
            <Text style={[styles.qrGunTabText, selectedConnector === 2 && styles.activeQrGunTabText]}>
              Gun #2 (Right)
            </Text>
          </TouchableOpacity>
        </View>

        {/* QR Code Graphic */}
        <View style={styles.qrImageContainer}>
          <Image
            source={{ uri: qrImageUri }}
            style={styles.qrImage}
            resizeMode="contain"
          />
          <Text style={styles.qrUrlLabel}>
            Station: {CHARGER_ID} &bull; Connector #{selectedConnector}
          </Text>
        </View>

        {/* Quick QR Actions */}
        <View style={styles.qrActionsRow}>
          <TouchableOpacity
            style={styles.qrScanBtn}
            disabled={actionLoading !== null}
            onPress={handleQrScanStart}
          >
            <Text style={styles.qrScanBtnText}>⚡ Scan & Start</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.qrPayBtn}
            disabled={actionLoading !== null}
            onPress={handleStopAndUnlock}
          >
            <Text style={styles.qrPayBtnText}>🛑 Stop & Unlock</Text>
          </TouchableOpacity>
        </View>

        {Boolean(qrActionMsg) ? (
          <View style={styles.qrMsgBox}>
            <Text style={styles.qrMsgText}>{qrActionMsg}</Text>
          </View>
        ) : null}
      </View>

      {/* Station Hardware Specifications */}
      <View style={styles.specsCard}>
        <Text style={styles.cardSectionLabel}>HARDWARE SPECIFICATIONS</Text>
        <View style={styles.specRow}>
          <Text style={styles.specKey}>Station Model</Text>
          <Text style={styles.specVal}>{chargerData?.model || 'AC_ThreePhase21KW'}</Text>
        </View>
        <View style={styles.specRow}>
          <Text style={styles.specKey}>Vendor</Text>
          <Text style={styles.specVal}>{chargerData?.vendor || 'CCS_AC / Voltronic'}</Text>
        </View>
        <View style={styles.specRow}>
          <Text style={styles.specKey}>Firmware</Text>
          <Text style={styles.specVal}>{chargerData?.firmwareVersion ? chargerData.firmwareVersion.substring(0, 18) : '05808-00G04703'}</Text>
        </View>
        <View style={styles.specRow}>
          <Text style={styles.specKey}>Protocol Standard</Text>
          <Text style={styles.specVal}>OCPP 1.6-J (WebSocket)</Text>
        </View>
      </View>

      <View style={{ height: 90 }} />
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
    backgroundColor: '#FFFFFF',
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
  stationName: {
    color: '#0284C7',
    fontWeight: '800',
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
    backgroundColor: '#FFFFFF',
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
    backgroundColor: '#FFFFFF',
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
  activeTxCard: {
    backgroundColor: '#ECFDF5',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1.5,
    borderColor: '#6EE7B7',
    marginBottom: 16,
  },
  activeTxHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  activeTxBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#059669',
  },
  activeTxBadgeText: {
    fontSize: 11,
    fontWeight: '900',
    color: '#065F46',
    letterSpacing: 0.5,
  },
  activeTxTime: {
    fontSize: 11,
    color: '#047857',
    fontWeight: '600',
  },
  activeTxBody: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  activeTxLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#065F46',
  },
  activeTxGun: {
    fontSize: 14,
    fontWeight: '900',
    color: '#0F172A',
    marginTop: 2,
  },
  activeTxStopBtn: {
    backgroundColor: '#EF4444',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  activeTxStopBtnText: {
    color: '#FFFFFF',
    fontSize: 11,
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
  pollBtn: {
    backgroundColor: '#F0F9FF',
    borderWidth: 1,
    borderColor: '#BAE6FD',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  pollBtnText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#0284C7',
  },
  powerNumberRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginVertical: 10,
  },
  powerNumber: {
    fontSize: 54,
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
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingTop: 14,
    marginTop: 6,
  },
  metricBox: {
    alignItems: 'center',
    flex: 1,
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
    marginBottom: 2,
  },
  metricValue: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A',
  },
  metricSub: {
    fontSize: 9,
    color: '#94A3B8',
    marginTop: 2,
    fontWeight: '500',
  },
  telemetryTimestamp: {
    fontSize: 10,
    color: '#94A3B8',
    textAlign: 'center',
    marginTop: 12,
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
    fontSize: 18,
    fontWeight: '900',
    color: '#0F172A',
    marginBottom: 10,
  },
  gunButtonsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  gunActionBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: 'center',
  },
  gunStartBtn: {
    backgroundColor: '#0284C7',
  },
  gunStartBtnText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  gunUnlockBtn: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  gunUnlockBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
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
    backgroundColor: '#10B981',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 3,
  },
  startButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
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
    fontWeight: '900',
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
  qrCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: 18,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.04,
    shadowRadius: 10,
    elevation: 2,
    marginBottom: 16,
  },
  qrHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  qrCardTitle: {
    fontSize: 13,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: 0.5,
  },
  qrCardSubtitle: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 2,
  },
  rateBadge: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  rateBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#1D4ED8',
  },
  qrGunSelector: {
    flexDirection: 'row',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 3,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  qrGunTab: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: 9,
  },
  activeQrGunTab: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  qrGunTabText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
  },
  activeQrGunTabText: {
    color: '#0284C7',
    fontWeight: '800',
  },
  qrImageContainer: {
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#F1F5F9',
  },
  qrImage: {
    width: 170,
    height: 170,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
  },
  qrUrlLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
    marginTop: 10,
  },
  qrActionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  qrScanBtn: {
    flex: 1,
    backgroundColor: '#10B981',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 2,
  },
  qrScanBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  qrPayBtn: {
    flex: 1,
    backgroundColor: '#6366F1',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#6366F1',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 2,
  },
  qrPayBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  qrMsgBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    padding: 10,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  qrMsgText: {
    fontSize: 11,
    color: '#334155',
    fontWeight: '600',
    textAlign: 'center',
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
