import React, { useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
} from 'react-native';
import { useSimulator, SimulatorScenario } from '@/config/simulator';

interface ScenarioOption {
  key: SimulatorScenario;
  title: string;
  badge: string;
  badgeColor: string;
  desc: string;
}

const OPTIONS: ScenarioOption[] = [
  {
    key: 'live',
    title: 'Live Hardware',
    badge: 'ONLINE',
    badgeColor: '#059669',
    desc: 'Real live OCPP connection with physical charger.',
  },
  {
    key: 'both_plugged',
    title: 'Both Cars Plugged In',
    badge: '1 CHARGING, 1 STANDBY',
    badgeColor: '#0284C7',
    desc: 'Gun A: 36.8 kW (26% SoC) • Gun B: Plugged (86% SoC).',
  },
  {
    key: 'both_charging',
    title: 'Both Cars Charging',
    badge: 'DUAL FAST CHARGING',
    badgeColor: '#10B981',
    desc: 'Gun A: 117.2 kW (45% SoC) • Gun B: 85.0 kW (60% SoC).',
  },
  {
    key: 'single_charging',
    title: 'Single Car Charging',
    badge: '120 kW FAST',
    badgeColor: '#10B981',
    desc: 'Gun A: 120.0 kW (52% SoC) • Gun B: Available.',
  },
  {
    key: 'single_preparing',
    title: 'Car Plugged In (Preparing)',
    badge: 'HANDSHAKE',
    badgeColor: '#D97706',
    desc: 'Cable inserted in EV, ready to initiate charge.',
  },
  {
    key: 'standby',
    title: 'Standby / Idle',
    badge: 'STANDBY',
    badgeColor: '#64748B',
    desc: 'Both guns available on station, no cars connected.',
  },
];

export function SimulatorButton({ onOpen }: { onOpen: () => void }) {
  const { isSimulating, scenario } = useSimulator();

  return (
    <TouchableOpacity
      style={[
        styles.triggerBtn,
        isSimulating ? styles.triggerBtnActive : styles.triggerBtnNormal,
      ]}
      onPress={onOpen}
      activeOpacity={0.7}
    >
      <Text style={[styles.triggerText, isSimulating && styles.triggerTextActive]}>
        {isSimulating ? '🧪 PREVIEW ACTIVE' : '🧪 TEST UI'}
      </Text>
    </TouchableOpacity>
  );
}

export function SimulatorModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { scenario, setScenario } = useSimulator();

  const handleSelect = (sc: SimulatorScenario) => {
    setScenario(sc);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet}>
              <View style={styles.sheetHeader}>
                <View>
                  <Text style={styles.sheetTitle}>UI State Simulator</Text>
                  <Text style={styles.sheetSub}>
                    Preview any charger state without plugging in a car
                  </Text>
                </View>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Text style={styles.closeText}>✕</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.optionsList}>
                {OPTIONS.map((opt) => {
                  const isSelected = scenario === opt.key;
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      style={[
                        styles.optionCard,
                        isSelected && styles.optionCardSelected,
                      ]}
                      onPress={() => handleSelect(opt.key)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.optionTopRow}>
                        <Text style={styles.optionTitle}>{opt.title}</Text>
                        <View
                          style={[
                            styles.badgePill,
                            { backgroundColor: `${opt.badgeColor}15` },
                          ]}
                        >
                          <Text
                            style={[
                              styles.badgeText,
                              { color: opt.badgeColor },
                            ]}
                          >
                            {opt.badge}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.optionDesc}>{opt.desc}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  triggerBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  triggerBtnNormal: {
    backgroundColor: '#F1F5F9',
    borderColor: '#CBD5E1',
  },
  triggerBtnActive: {
    backgroundColor: 'rgba(217, 119, 6, 0.1)',
    borderColor: '#D97706',
  },
  triggerText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#475569',
    letterSpacing: 0.6,
  },
  triggerTextActive: {
    color: '#D97706',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 36,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: -0.3,
  },
  sheetSub: {
    fontSize: 12,
    fontWeight: '500',
    color: '#64748B',
    marginTop: 2,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#64748B',
  },
  optionsList: {
    gap: 10,
  },
  optionCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
  },
  optionCardSelected: {
    backgroundColor: '#F0F9FF',
    borderColor: '#0284C7',
  },
  optionTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  optionTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A',
  },
  badgePill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  optionDesc: {
    fontSize: 11,
    fontWeight: '500',
    color: '#64748B',
  },
});
