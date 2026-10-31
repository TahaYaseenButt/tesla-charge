import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/config/auth';
import { useChargerLive } from '@/hooks/useChargerLive';
import {
  startChargingSession,
  stopChargingSession,
  unlockConnector,
  LimitMode,
  ChargingLimit,
} from '@/services/control';

const STATUS_THEMES: Record<string, { color: string; label: string; bg: string; border: string }> = {
  Charging: { color: '#059669', label: 'CHARGING', bg: 'rgba(16, 185, 129, 0.08)', border: 'rgba(16, 185, 129, 0.25)' },
  Preparing: { color: '#D97706', label: 'PLUGGED IN (PREPARING)', bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.25)' },
  SuspendedEV: { color: '#6366F1', label: 'PAUSED (CAR)', bg: 'rgba(99, 102, 241, 0.08)', border: 'rgba(99, 102, 241, 0.25)' },
  SuspendedEVSE: { color: '#6366F1', label: 'PAUSED (STATION)', bg: 'rgba(99, 102, 241, 0.08)', border: 'rgba(99, 102, 241, 0.25)' },
  Finishing: { color: '#0284C7', label: 'COMPLETED', bg: 'rgba(2, 132, 199, 0.08)', border: 'rgba(2, 132, 199, 0.25)' },
  Available: { color: '#475569', label: 'AVAILABLE (STANDBY)', bg: 'rgba(100, 116, 139, 0.06)', border: 'rgba(100, 116, 139, 0.15)' },
  Unavailable: { color: '#94A3B8', label: 'OFFLINE', bg: 'rgba(148, 163, 184, 0.06)', border: 'rgba(148, 163, 184, 0.15)' },
  Faulted: { color: '#DC2626', label: 'FAULT', bg: 'rgba(220, 38, 38, 0.08)', border: 'rgba(220, 38, 38, 0.25)' },
};

const PRESETS: Record<LimitMode, number[]> = {
  full: [100],
  time: [30, 45, 60, 120], // minutes
  energy: [10, 20, 35, 50], // kWh
  price: [500, 1000, 2000, 3500], // currency amount
};

export default function ControlScreen() {
  const { chargerId, chargerModel, tariffRate, user } = useAuth();
  const currency = 'PKR';
  const CHARGER_ID = chargerId || 'charger1';
  const is30kW = chargerModel?.toLowerCase().includes('30');

  const {
    isOnline,
    connector1,
    connector2,
    isGunAConnected,
    isGunBConnected,
    hasAnyGunConnected,
    bothConnected,
  } = useChargerLive(CHARGER_ID);

  // Active Gun selection (if both connected, user can switch between Gun A and Gun B)
  const [selectedGun, setSelectedGun] = useState<1 | 2>(() => {
    if (connector2.status === 'Charging') return 2;
    if (connector1.status === 'Charging') return 1;
    return isGunBConnected && !isGunAConnected ? 2 : 1;
  });

  // Automatically track actively charging connector
  useEffect(() => {
    if (connector2.status === 'Charging' && connector1.status !== 'Charging') {
      setSelectedGun(2);
    } else if (connector1.status === 'Charging' && connector2.status !== 'Charging') {
      setSelectedGun(1);
    }
  }, [connector1.status, connector2.status]);

  // Selected gun (user can switch between Gun 1 and Gun 2 anytime on multi-gun stations)
  const activeGunId: 1 | 2 = is30kW ? 1 : selectedGun;

  const currentConnector = activeGunId === 1 ? connector1 : connector2;
  const isCharging = currentConnector.status === 'Charging';

  // Limit selection state
  const [limitMode, setLimitMode] = useState<LimitMode>('full');
  const [targetValue, setTargetValue] = useState<number>(100);
  const [customInput, setCustomInput] = useState<string>('');
  const [isCustom, setIsCustom] = useState<boolean>(false);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [unlockLoading, setUnlockLoading] = useState<boolean>(false);
  const [liveAccumulated, setLiveAccumulated] = useState<number>(0);

  // Handle Preset Chip Click
  const handleSelectPreset = (val: number) => {
    setIsCustom(false);
    setTargetValue(val);
    setCustomInput(String(val));
  };

  // Handle Limit Mode Change
  const handleChangeMode = (mode: LimitMode) => {
    setLimitMode(mode);
    setIsCustom(false);
    const defaultVal = PRESETS[mode][0];
    setTargetValue(defaultVal);
    setCustomInput(String(defaultVal));
  };

  // Live telemetry directly from OCPP server for selected gun
  const tel = currentConnector.telemetry || {};
  const livePower = Number(tel.powerKw || 0);
  const liveVoltage = tel.voltage ? Math.round(Number(tel.voltage)) : (tel.voltageL1 ? Math.round(Number(tel.voltageL1)) : 0);
  const liveCurrent = Number(tel.currentL1 || 0);

  // Session Energy (delivered strictly in the current charging session)
  const deliveredFromTx = Number(currentConnector.activeTx?.energyDeliveredKwh) || 0;
  const mStart =
    currentConnector.activeTx?.meterStart !== undefined && currentConnector.activeTx?.meterStart !== null
      ? Number(currentConnector.activeTx.meterStart)
      : null;
  const currentEnergyWh = tel.energyWh || (tel.energyKwh ? Math.round(Number(tel.energyKwh) * 1000) : null);
  const computedFromMeter =
    mStart !== null && mStart > 0 && currentEnergyWh !== null && currentEnergyWh >= mStart
      ? Math.max(0, (currentEnergyWh - mStart) / 1000)
      : 0;
  const baseEnergy =
    computedFromMeter > 0
      ? computedFromMeter
      : deliveredFromTx > 0
      ? deliveredFromTx
      : 0;
  const sessionEnergyKwh = Number((baseEnergy + liveAccumulated).toFixed(2));
  // Gun Total Register (lifetime energy passed through the physical gun meter)
  const lifetimeMeterKwh = Number(tel.energyKwh || (tel.energyWh ? tel.energyWh / 1000 : 0)).toFixed(2);

  // Real-time Session Cost: strictly based on the current session kWh (clean integer, no decimals)
  const liveCost = Math.round(sessionEnergyKwh * (tariffRate || 125)).toLocaleString();
  const liveEnergy = sessionEnergyKwh;

  // Real-time 1-second auto-interpolator when actively charging
  useEffect(() => {
    if (!isCharging || livePower <= 0) {
      setLiveAccumulated(0);
      return;
    }
    const timer = setInterval(() => {
      setLiveAccumulated((prev) => prev + (livePower / 3600));
    }, 1000);
    return () => clearInterval(timer);
  }, [isCharging, livePower]);

  useEffect(() => {
    setLiveAccumulated(0);
  }, [tel.energyWh, tel.energyKwh]);

  // Real-time Vehicle Battery State of Charge (SoC %)
  const currentSoc =
    typeof tel.soc === 'number' && tel.soc > 0
      ? tel.soc
      : typeof currentConnector.activeTx?.soc === 'number' && currentConnector.activeTx.soc > 0
      ? currentConnector.activeTx.soc
      : typeof currentConnector.activeTx?.socCurrent === 'number' && currentConnector.activeTx.socCurrent > 0
      ? currentConnector.activeTx.socCurrent
      : null;

  // Normalized Target kWh calculation
  let targetKwh: number | null = null;
  let targetLabel = 'Until full';
  if (limitMode === 'energy') {
    targetKwh = isCustom ? Number(customInput) || 20 : targetValue;
    targetLabel = `${targetKwh} kWh`;
  } else if (limitMode === 'price') {
    const budget = isCustom ? Number(customInput) || 1000 : targetValue;
    targetKwh = tariffRate > 0 ? Number((budget / tariffRate).toFixed(1)) : 20;
    targetLabel = `${currency} ${budget.toLocaleString()} (~${targetKwh} kWh)`;
  } else if (limitMode === 'time') {
    const mins = isCustom ? Number(customInput) || 60 : targetValue;
    targetKwh = Number(((11 * mins) / 60).toFixed(1));
    targetLabel = `${mins} min (~${targetKwh} kWh)`;
  }

  // Calculate charging progress if targetKwh exists
  const progressPercent =
    targetKwh && targetKwh > 0
      ? Math.min(100, Math.round((Number(liveEnergy) / targetKwh) * 100))
      : null;

  // Client-side Fail-safe Auto-Stop Watchdog:
  // Evaluates with strictly '>=' (never '==') so multi-step energy/price jumps never bypass limits
  const autoStopSentRef = useRef<boolean>(false);
  const activeTxId = currentConnector.activeTx?.transactionId;

  useEffect(() => {
    autoStopSentRef.current = false;
  }, [activeTxId, isCharging]);

  useEffect(() => {
    if (!isCharging || !currentConnector.activeTx || autoStopSentRef.current) return;

    const rawCost = sessionEnergyKwh * (tariffRate || 125);
    const tx = currentConnector.activeTx;
    const targetPriceVal = tx.targetPrice || (tx.limitMode === 'price' ? tx.limitValue : null);
    const targetKwhVal = tx.targetKwh || (tx.limitMode === 'energy' ? tx.limitValue : null);

    let reached = false;
    let limitDesc = '';

    if (targetPriceVal && targetPriceVal > 0 && rawCost >= targetPriceVal) {
      reached = true;
      limitDesc = `Budget limit of ${currency} ${targetPriceVal} reached`;
    } else if (targetKwhVal && targetKwhVal > 0 && sessionEnergyKwh >= targetKwhVal) {
      reached = true;
      limitDesc = `Energy limit of ${targetKwhVal} kWh reached`;
    }

    if (reached) {
      autoStopSentRef.current = true;
      console.log(`[Client Auto-Stop] ${limitDesc}. Automatically stopping session...`);
      stopChargingSession(CHARGER_ID, activeGunId, currentConnector.activeTx, user).then((res) => {
        if (res.success && Platform.OS !== 'web') {
          Alert.alert('Target Limit Reached', `${limitDesc}. Charging stopped automatically.`);
        }
      });
    }
  }, [isCharging, sessionEnergyKwh, tariffRate, currentConnector.activeTx, currency, activeGunId, user, CHARGER_ID]);

  // Execute Start Charging
  const handleStartCharging = async () => {
    if (currentConnector.status === 'Available') {
      Alert.alert(
        'Connect Cable First',
        `Gun ${activeGunId === 1 ? 'A' : 'B'} is in the station holster. Please plug the cable into your vehicle port, then tap Start Charging.`
      );
      return;
    }

    setActionLoading(true);
    const limit: ChargingLimit = {
      mode: limitMode,
      targetValue: isCustom ? Number(customInput) || targetValue : targetValue,
      targetKwh,
    };

    const res = await startChargingSession(CHARGER_ID, activeGunId, limit, tariffRate || 125, user);
    setActionLoading(false);

    if (res.success) {
      if (Platform.OS !== 'web') {
        Alert.alert('Charging Started', `Gun ${activeGunId === 1 ? 'A' : 'B'} is now charging.`);
      }
    } else {
      Alert.alert('Start Failed', res.error || 'Could not communicate with station.');
    }
  };

  // Execute Stop Charging (strictly stops electrical power flow)
  const handleStopCharging = async () => {
    setActionLoading(true);
    const res = await stopChargingSession(CHARGER_ID, activeGunId, currentConnector.activeTx, user);
    setActionLoading(false);

    if (res.success) {
      if (Platform.OS !== 'web') {
        Alert.alert(
          'Charging Stopped',
          `Power flow to Gun ${activeGunId === 1 ? 'A' : 'B'} stopped. You can now tap 'Unlock Gun' if you wish to remove the cable.`
        );
      }
    } else {
      Alert.alert('Stop Failed', res.error || 'Could not send stop command.');
    }
  };

  // Execute Unlock Gun (strictly releases physical cable connector latch)
  const handleUnlockGun = async () => {
    if (isCharging) {
      Alert.alert(
        'Stop Charging First',
        'Electricity is actively flowing. Stop charging session first before unlocking the gun cable.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Stop & Unlock',
            style: 'destructive',
            onPress: async () => {
              setActionLoading(true);
              const stopRes = await stopChargingSession(CHARGER_ID, activeGunId, currentConnector.activeTx, user);
              setActionLoading(false);
              if (stopRes.success) {
                setUnlockLoading(true);
                const unlockRes = await unlockConnector(CHARGER_ID, activeGunId, user);
                setUnlockLoading(false);
                if (unlockRes.success) {
                  Alert.alert('Gun Unlocked', `Gun ${activeGunId === 1 ? 'A' : 'B'} cable latch released.`);
                } else {
                  Alert.alert('Unlock Failed', unlockRes.error || 'Could not unlock cable.');
                }
              }
            },
          },
        ]
      );
      return;
    }

    setUnlockLoading(true);
    const res = await unlockConnector(CHARGER_ID, activeGunId, user);
    setUnlockLoading(false);

    if (res.success) {
      if (Platform.OS !== 'web') {
        Alert.alert(
          'Station Latch Released',
          `Gun ${activeGunId === 1 ? 'A' : 'B'} latch is unlocked.\n\nTip: If the cable is still held by the vehicle, press the UNLOCK button on your car key fob 2–3 times to release the car's charge port pin.`
        );
      }
    } else {
      Alert.alert('Unlock Failed', res.error || 'Could not send unlock command to station.');
    }
  };

  const statusTheme = STATUS_THEMES[currentConnector.status] || STATUS_THEMES.Available;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Top Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>CHARGER CONTROL</Text>
          <Text style={styles.subtitle}>
            Station {CHARGER_ID.toUpperCase()} &bull; {currency} {tariffRate}/kWh
          </Text>
        </View>

        <TouchableOpacity onPress={() => router.push('/(tabs)')} style={styles.dashboardBtn}>
          <Text style={styles.dashboardBtnText}>Live Feed &rarr;</Text>
        </TouchableOpacity>
      </View>

      {/* Dynamic Gun Switcher: Always accessible for multi-gun chargers */}
      {!is30kW && (
        <View style={styles.gunSelector}>
          <TouchableOpacity
            style={[styles.gunSelectorBtn, activeGunId === 1 && styles.gunSelectorBtnActive]}
            onPress={() => setSelectedGun(1)}
          >
            <View
              style={[
                styles.gunStatusDot,
                {
                  backgroundColor:
                    connector1.status === 'Charging'
                      ? '#10B981'
                      : connector1.status === 'Preparing'
                      ? '#F59E0B'
                      : '#64748B',
                },
              ]}
            />
            <Text
              style={[
                styles.gunSelectorText,
                activeGunId === 1 && styles.gunSelectorTextActive,
              ]}
            >
              GUN A ({connector1.status || 'Available'})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.gunSelectorBtn, activeGunId === 2 && styles.gunSelectorBtnActive]}
            onPress={() => setSelectedGun(2)}
          >
            <View
              style={[
                styles.gunStatusDot,
                {
                  backgroundColor:
                    connector2.status === 'Charging'
                      ? '#10B981'
                      : connector2.status === 'Preparing'
                      ? '#F59E0B'
                      : '#64748B',
                },
              ]}
            />
            <Text
              style={[
                styles.gunSelectorText,
                activeGunId === 2 && styles.gunSelectorTextActive,
              ]}
            >
              GUN B ({connector2.status || 'Available'})
            </Text>
          </TouchableOpacity>
        </View>
      )}

          {/* Active Connector Hero Card */}
          <View style={styles.heroCard}>
            <View style={styles.heroHeader}>
              <View style={styles.heroGunBadge}>
                <Text style={styles.heroGunBadgeText}>
                  {is30kW
                    ? 'CONNECTOR 1 (SINGLE GUN)'
                    : activeGunId === 1
                    ? 'CONNECTOR 1 (GUN A)'
                    : 'CONNECTOR 2 (GUN B)'}
                </Text>
              </View>

              <View style={[styles.statusPill, { backgroundColor: statusTheme.bg, borderColor: statusTheme.border }]}>
                <View style={[styles.statusDot, { backgroundColor: statusTheme.color }]} />
                <Text style={[styles.statusText, { color: statusTheme.color }]}>
                  {statusTheme.label}
                </Text>
              </View>
            </View>

            {/* Status Guidance Banner */}
            {currentConnector.status === 'Available' ? (
              <View style={{ backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 10, padding: 10, marginTop: 12 }}>
                <Text style={{ fontSize: 12, color: '#64748B', textAlign: 'center', fontWeight: '500' }}>
                  ℹ Gun is idle in holster. Connect cable to vehicle port to start session.
                </Text>
              </View>
            ) : currentConnector.status === 'Preparing' ? (
              <View style={{ backgroundColor: 'rgba(245, 158, 11, 0.08)', borderWidth: 1, borderColor: 'rgba(245, 158, 11, 0.25)', borderRadius: 10, padding: 10, marginTop: 12 }}>
                <Text style={{ fontSize: 12, color: '#D97706', textAlign: 'center', fontWeight: '700' }}>
                  ⚡ Vehicle plugged in (Preparing). Select limit below & tap Start Charging.
                </Text>
              </View>
            ) : null}

            {/* Primary Hero Heading: LIVE PRICE (PKR Below Amount) */}
            <View style={styles.priceHeadingSection}>
              <Text style={styles.priceHeadingLabel}>SESSION TOTAL</Text>
              <Text style={styles.priceValueNumber}>{liveCost}</Text>
              <Text style={styles.priceCurrencyBelow}>PKR</Text>
            </View>

            {/* Sub-heading: BATTERY LEVEL (Clean, Minimalist Gauge) */}
            {currentSoc !== null ? (
              <View style={styles.batteryMinimalContainer}>
                <View style={styles.batteryMinimalTop}>
                  <View style={styles.batteryTitleRow}>
                    <View style={styles.batteryLiveDot} />
                    <Text style={styles.batteryMinimalTitle}>BATTERY LEVEL</Text>
                  </View>
                  <Text style={styles.batteryMinimalPercent}>{currentSoc}%</Text>
                </View>
                <View style={styles.batteryMinimalTrack}>
                  <View
                    style={[
                      styles.batteryMinimalFill,
                      { width: `${Math.min(100, Math.max(0, currentSoc))}%` },
                    ]}
                  />
                </View>
              </View>
            ) : null}

            {/* Live Metrics Row: ENERGY, POWER, CURRENT, VOLTAGE */}
            <View style={styles.liveCostRow}>
              <View style={styles.costItem}>
                <Text style={styles.costLabel}>SESSION ENERGY</Text>
                <Text style={styles.costValue}>{Number(liveEnergy).toFixed(2)} kWh</Text>
              </View>
              <View style={styles.costDivider} />
              <View style={styles.costItem}>
                <Text style={styles.costLabel}>POWER</Text>
                <Text style={styles.costValue}>{livePower.toFixed(1)} kW</Text>
              </View>
              <View style={styles.costDivider} />
              <View style={styles.costItem}>
                <Text style={styles.costLabel}>CURRENT</Text>
                <Text style={styles.costValue}>{liveCurrent.toFixed(1)} A</Text>
              </View>
              <View style={styles.costDivider} />
              <View style={styles.costItem}>
                <Text style={styles.costLabel}>VOLTAGE</Text>
                <Text style={styles.costValue}>{liveVoltage} V</Text>
              </View>
            </View>

            {/* Lifetime Gun Meter Register */}
            <View style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: 0.85 }}>
              <Text style={{ fontSize: 11, color: '#64748B', fontWeight: '500' }}>
                Gun Lifetime Meter:
              </Text>
              <Text style={{ fontSize: 11, color: '#0F172A', fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>
                {lifetimeMeterKwh} kWh
              </Text>
            </View>

            {/* Progress Bar (if charging with target) */}
            {isCharging && progressPercent !== null && (
              <View style={styles.progressSection}>
                <View style={styles.progressLabelRow}>
                  <Text style={styles.progressLabel}>Target: {targetLabel}</Text>
                  <Text style={styles.progressPercent}>{progressPercent}%</Text>
                </View>
                <View style={styles.progressBarTrack}>
                  <View
                    style={[styles.progressBarFill, { width: `${progressPercent}%` }]}
                  />
                </View>
              </View>
            )}
          </View>

          {/* Limit Configuration Card (Visible when Ready to Charge or Adjusting) */}
          {!isCharging ? (
            <View style={styles.configCard}>
              <Text style={styles.sectionTitle}>SELECT CHARGE LIMIT</Text>

              {/* Mode Selector Tabs */}
              <View style={styles.modeTabs}>
                {(['full', 'time', 'energy', 'price'] as LimitMode[]).map((mode) => {
                  const labels: Record<LimitMode, string> = {
                    full: 'MAX',
                    time: 'TIME',
                    energy: 'ENERGY',
                    price: 'BUDGET',
                  };
                  const active = limitMode === mode;
                  return (
                    <TouchableOpacity
                      key={mode}
                      style={[styles.modeTab, active && styles.modeTabActive]}
                      onPress={() => handleChangeMode(mode)}
                    >
                      <Text style={[styles.modeTabText, active && styles.modeTabTextActive]}>
                        {labels[mode]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Mode-specific Quick Presets & Custom Input */}
              {limitMode !== 'full' && (
                <View style={styles.presetsArea}>
                  <View style={styles.chipsRow}>
                    {PRESETS[limitMode].map((val) => {
                      const isSelected = !isCustom && targetValue === val;
                      const suffix =
                        limitMode === 'time'
                          ? 'min'
                          : limitMode === 'energy'
                          ? 'kWh'
                          : currency;
                      return (
                        <TouchableOpacity
                          key={val}
                          style={[styles.presetChip, isSelected && styles.presetChipActive]}
                          onPress={() => handleSelectPreset(val)}
                        >
                          <Text
                            style={[
                              styles.presetChipText,
                              isSelected && styles.presetChipTextActive,
                            ]}
                          >
                            {limitMode === 'price' ? `${currency} ${val}` : `${val} ${suffix}`}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}

                    <TouchableOpacity
                      style={[styles.presetChip, isCustom && styles.presetChipActive]}
                      onPress={() => setIsCustom(true)}
                    >
                      <Text
                        style={[
                          styles.presetChipText,
                          isCustom && styles.presetChipTextActive,
                        ]}
                      >
                        Custom...
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {/* Custom Input Field */}
                  {isCustom && (
                    <View style={styles.customInputRow}>
                      <Text style={styles.customInputPrefix}>
                        {limitMode === 'price' ? currency : limitMode === 'energy' ? 'kWh' : 'min'}
                      </Text>
                      <TextInput
                        style={styles.customInput}
                        keyboardType="numeric"
                        placeholder="Enter value"
                        placeholderTextColor="#94A3B8"
                        value={customInput}
                        onChangeText={setCustomInput}
                        autoFocus
                      />
                    </View>
                  )}

                  <Text style={styles.summaryTargetText}>
                    Selected limit: <Text style={styles.summaryTargetBold}>{targetLabel}</Text>
                  </Text>
                </View>
              )}

              {/* Start Charging CTA */}
              <TouchableOpacity
                style={[styles.startBtn, actionLoading && { opacity: 0.85 }]}
                onPress={handleStartCharging}
                disabled={actionLoading || unlockLoading}
              >
                {actionLoading ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <ActivityIndicator color="#FFFFFF" size="small" />
                    <Text style={styles.startBtnText}>CONFIRMING WITH CHARGER...</Text>
                  </View>
                ) : (
                  <Text style={styles.startBtnText}>
                    ⚡ START CHARGING {limitMode === 'full' ? '(FULL)' : `(${targetLabel})`} &rarr;
                  </Text>
                )}
              </TouchableOpacity>

              {/* Dedicated Unlock Gun CTA (when connected / not charging) */}
              <TouchableOpacity
                style={[styles.unlockBtn, { marginTop: 12 }, unlockLoading && { opacity: 0.85 }]}
                onPress={handleUnlockGun}
                disabled={actionLoading || unlockLoading}
              >
                {unlockLoading ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <ActivityIndicator color="#0284C7" size="small" />
                    <Text style={styles.unlockBtnText}>RELEASING LATCH AT STATION...</Text>
                  </View>
                ) : (
                  <Text style={styles.unlockBtnText}>
                    🔓 UNLOCK GUN {activeGunId === 1 ? 'A' : 'B'} (RELEASE CABLE)
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            /* Active Charging Control Panel */
            <View style={styles.activeControlCard}>
              <View style={styles.activeChargingHeader}>
                <View style={styles.pulsingDot} />
                <Text style={styles.activeChargingTitle}>Charging in Progress</Text>
              </View>

              <Text style={styles.activeChargingSub}>
                Energy is flowing safely to your battery. Controls below are completely separate:
              </Text>

              {/* Two Separate Buttons: Stop Charging & Unlock Gun */}
              <View style={styles.actionButtonsContainer}>
                {/* 1. Stop Charging Button */}
                <TouchableOpacity
                  style={[styles.stopBtn, actionLoading && { opacity: 0.85 }]}
                  onPress={handleStopCharging}
                  disabled={actionLoading || unlockLoading}
                >
                  {actionLoading ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <ActivityIndicator color="#FFFFFF" size="small" />
                      <Text style={styles.stopBtnText}>CONFIRMING STOP WITH CHARGER...</Text>
                    </View>
                  ) : (
                    <Text style={styles.stopBtnText}>⏹ STOP CHARGING SESSION</Text>
                  )}
                </TouchableOpacity>

                {/* 2. Separate Unlock Gun Button */}
                <TouchableOpacity
                  style={[styles.unlockBtn, unlockLoading && { opacity: 0.85 }]}
                  onPress={handleUnlockGun}
                  disabled={actionLoading || unlockLoading}
                >
                  {unlockLoading ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <ActivityIndicator color="#0284C7" size="small" />
                      <Text style={styles.unlockBtnText}>RELEASING LATCH AT STATION...</Text>
                    </View>
                  ) : (
                    <Text style={styles.unlockBtnText}>
                      🔓 UNLOCK GUN {activeGunId === 1 ? 'A' : 'B'}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}

      <View style={{ height: 40 }} />
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 12,
    color: '#64748B',
    fontWeight: '600',
    marginTop: 2,
  },
  dashboardBtn: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  dashboardBtnText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#0284C7',
  },
  emptyCard: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 20,
    padding: 32,
    alignItems: 'center',
    marginTop: 20,
  },
  emptyIndicatorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#94A3B8',
    marginBottom: 14,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#0F172A',
    marginBottom: 6,
  },
  emptySub: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 20,
  },
  returnBtn: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
  },
  returnBtnText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 13,
  },
  gunSelector: {
    flexDirection: 'row',
    backgroundColor: '#F1F5F9',
    borderRadius: 14,
    padding: 4,
    marginBottom: 16,
    gap: 6,
  },
  gunSelectorBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 11,
    gap: 8,
  },
  gunSelectorBtnActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  gunStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  gunSelectorText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748B',
  },
  gunSelectorTextActive: {
    color: '#0F172A',
    fontWeight: '900',
  },
  heroCard: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 20,
    padding: 20,
    marginBottom: 16,
  },
  heroHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  heroGunBadge: {
    backgroundColor: '#E2E8F0',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  heroGunBadgeText: {
    fontSize: 11,
    fontWeight: '900',
    color: '#1E293B',
    letterSpacing: 0.5,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  priceHeadingSection: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 14,
  },
  priceHeadingLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 1.5,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  priceValueNumber: {
    fontSize: 54,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -1.5,
    fontVariant: ['tabular-nums'],
  },
  priceCurrencyBelow: {
    fontSize: 13,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  batteryMinimalContainer: {
    width: '100%',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 16,
  },
  batteryMinimalTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  batteryTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  batteryLiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#10B981',
  },
  batteryMinimalTitle: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  batteryMinimalPercent: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
  },
  batteryMinimalTrack: {
    height: 4,
    backgroundColor: '#E2E8F0',
    borderRadius: 2,
    overflow: 'hidden',
  },
  batteryMinimalFill: {
    height: '100%',
    backgroundColor: '#10B981',
    borderRadius: 2,
  },
  powerDisplay: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    marginVertical: 12,
  },
  powerValue: {
    fontSize: 48,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -1,
  },
  powerUnit: {
    fontSize: 18,
    fontWeight: '800',
    color: '#64748B',
    marginLeft: 6,
  },
  liveCostRow: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginTop: 8,
  },
  costItem: {
    flex: 1,
    alignItems: 'center',
  },
  costDivider: {
    width: 1,
    backgroundColor: '#E2E8F0',
  },
  costLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: '#94A3B8',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  costValue: {
    fontSize: 16,
    fontWeight: '900',
    color: '#0F172A',
  },
  progressSection: {
    marginTop: 16,
  },
  progressLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  progressLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
  },
  progressPercent: {
    fontSize: 11,
    fontWeight: '900',
    color: '#10B981',
  },
  progressBarTrack: {
    height: 8,
    backgroundColor: '#E2E8F0',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#10B981',
    borderRadius: 4,
  },
  configCard: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 20,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.04,
    shadowRadius: 10,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.8,
    marginBottom: 12,
  },
  modeTabs: {
    flexDirection: 'row',
    backgroundColor: '#F1F5F9',
    borderRadius: 12,
    padding: 3,
    marginBottom: 16,
  },
  modeTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 9,
  },
  modeTabActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },
  modeTabText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
  },
  modeTabTextActive: {
    color: '#0F172A',
    fontWeight: '800',
  },
  presetsArea: {
    marginBottom: 16,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  presetChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  presetChipActive: {
    backgroundColor: '#0F172A',
    borderColor: '#0F172A',
  },
  presetChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
  },
  presetChipTextActive: {
    color: '#FFFFFF',
  },
  customInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  customInputPrefix: {
    fontSize: 13,
    fontWeight: '800',
    color: '#64748B',
    marginRight: 8,
  },
  customInput: {
    flex: 1,
    paddingVertical: 10,
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
  },
  summaryTargetText: {
    fontSize: 12,
    color: '#64748B',
    fontWeight: '600',
    marginTop: 4,
  },
  summaryTargetBold: {
    color: '#0284C7',
    fontWeight: '800',
  },
  startBtn: {
    backgroundColor: '#10B981',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 3,
  },
  startBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  activeControlCard: {
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: '#BBF7D0',
    borderRadius: 20,
    padding: 22,
    alignItems: 'center',
  },
  activeChargingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  pulsingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#10B981',
  },
  activeChargingTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#065F46',
  },
  activeChargingSub: {
    fontSize: 12,
    color: '#047857',
    textAlign: 'center',
    marginBottom: 18,
    lineHeight: 18,
  },
  actionButtonsContainer: {
    width: '100%',
    gap: 12,
  },
  stopBtn: {
    width: '100%',
    backgroundColor: '#EF4444',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#EF4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 3,
  },
  stopBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  unlockBtn: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: '#0284C7',
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#0284C7',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 2,
  },
  unlockBtnText: {
    color: '#0284C7',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
});
