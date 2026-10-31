import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  Image,
} from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/config/auth';

export const AVAILABLE_MODELS = [
  {
    id: '30kW',
    name: '30kW',
    guns: 1,
    gunsLabel: '1 Gun (Single)',
    image: require('@/assets/images/models/charger_30kw.png'),
  },
  {
    id: '60kW',
    name: '60kW',
    guns: 2,
    gunsLabel: '2 Guns (Dual)',
    image: require('@/assets/images/models/charger_60kw.png'),
  },
  {
    id: '240kW',
    name: '240kW',
    guns: 2,
    gunsLabel: '2 Guns (Dual)',
    image: require('@/assets/images/models/charger_240kw.png'),
  },
];

export default function SetupScreen() {
  const {
    chargerId: initialId,
    chargerModel: initialModel,
    saveSetup,
  } = useAuth();

  // Step 1: Model, Step 2: Identifier
  const [step, setStep] = useState<1 | 2>(1);

  // Form State
  const [selectedModel, setSelectedModel] = useState<string>(
    initialModel === '30kW' || initialModel === 'EVX_30KW'
      ? '30kW'
      : initialModel === '240kW' ||
        initialModel === '220kW' ||
        initialModel === 'EVX_240KW' ||
        initialModel?.toLowerCase().includes('240') ||
        initialModel?.toLowerCase().includes('220') ||
        initialModel === 'DC_EVSE'
      ? '240kW'
      : '60kW'
  );

  const [chargerId, setChargerId] = useState<string>(initialId || 'charger1');
  const [saving, setSaving] = useState<boolean>(false);

  const handleStep1Next = () => {
    setStep(2);
  };

  const handleCompleteSetup = async () => {
    const finalModel = selectedModel;
    const finalId = chargerId.trim().toLowerCase() || 'charger1';

    if (!finalId) {
      Alert.alert('Required', 'Please enter a charger identifier.');
      return;
    }

    setSaving(true);
    await saveSetup(finalModel, finalId, null);
    setSaving(false);

    router.replace('/(tabs)');
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTopRow}>
          <View style={styles.stepBadge}>
            <Text style={styles.stepBadgeText}>STEP {step} OF 2</Text>
          </View>
          <TouchableOpacity onPress={() => router.replace('/(tabs)')} style={styles.cancelBtn}>
            <Text style={styles.cancelBtnText}>&larr; Dashboard</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.title}>
          {step === 1 ? 'SELECT CHARGER MODEL' : 'CHARGER IDENTIFIER'}
        </Text>
        <Text style={styles.subtitle}>
          {step === 1
            ? 'Choose the hardware model for this station'
            : 'Choose the identifier for this charger'}
        </Text>
      </View>

      {/* STEP 1: SELECT CHARGER MODEL */}
      {step === 1 && (
        <View style={styles.stepSection}>
          <View style={styles.modelList}>
            {AVAILABLE_MODELS.map((m) => {
              const isSelected = selectedModel === m.id;
              return (
                <TouchableOpacity
                  key={m.id}
                  style={[styles.modelCard, isSelected && styles.modelCardSelected]}
                  onPress={() => setSelectedModel(m.id)}
                  activeOpacity={0.85}
                >
                  <View style={styles.modelImgContainer}>
                    <Image source={m.image} style={styles.modelImg} resizeMode="contain" />
                  </View>

                  <View style={{ flex: 1 }}>
                    <Text style={[styles.modelTitle, isSelected && styles.modelTitleSelected]}>
                      {m.name}
                    </Text>
                    <Text style={[styles.modelSubtitle, isSelected && styles.modelSubtitleSelected]}>
                      {m.gunsLabel} • DC Fast Charger
                    </Text>
                  </View>

                  <View style={[styles.radioDot, isSelected && styles.radioDotActive]} />
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Next Button */}
          <TouchableOpacity style={styles.primaryButton} onPress={handleStep1Next}>
            <Text style={styles.primaryButtonText}>NEXT &rarr;</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* STEP 2: CHARGER IDENTIFIER */}
      {step === 2 && (
        <View style={styles.stepSection}>
          {/* Selected Model Summary */}
          <View style={styles.summaryPillRow}>
            <Text style={styles.summaryPillLabel}>SELECTED MODEL:</Text>
            <TouchableOpacity onPress={() => setStep(1)} style={styles.changeModelBtn}>
              <Text style={styles.summaryPillValue}>{selectedModel}</Text>
              <Text style={styles.changeText}>(Change)</Text>
            </TouchableOpacity>
          </View>

          {/* Charger Identifier Input Card */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>CHARGER IDENTIFIER</Text>
            <Text style={styles.cardHelp}>
              Enter the station identifier matching your charger
            </Text>

            <TextInput
              style={styles.input}
              placeholder="charger1"
              placeholderTextColor="#94A3B8"
              autoCapitalize="none"
              autoCorrect={false}
              value={chargerId}
              onChangeText={setChargerId}
            />
          </View>

          {/* Action Buttons */}
          <View style={styles.actionsRow}>
            <TouchableOpacity style={styles.backButton} onPress={() => setStep(1)}>
              <Text style={styles.backButtonText}>&larr; Back</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.primaryButton, { flex: 2 }]}
              onPress={handleCompleteSetup}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryButtonText}>SAVE & LAUNCH APP &rarr;</Text>
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
    paddingHorizontal: 22,
    paddingTop: Platform.OS === 'ios' ? 60 : 36,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 20,
  },
  headerTopRow: {
    width: '100%',
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  cancelBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  cancelBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0284C7',
  },
  stepBadge: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  stepBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 22,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 4,
    fontWeight: '500',
  },
  stepSection: {
    gap: 16,
  },
  modelList: {
    gap: 12,
  },
  modelCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  modelCardSelected: {
    borderColor: '#0284C7',
    backgroundColor: '#F0F9FF',
    shadowColor: '#0284C7',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 2,
  },
  modelImgContainer: {
    width: 80,
    height: 90,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#F1F5F9',
    padding: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelImg: {
    width: '100%',
    height: '100%',
  },
  modelTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0F172A',
  },
  modelTitleSelected: {
    color: '#0369A1',
  },
  modelSubtitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 3,
  },
  modelSubtitleSelected: {
    color: '#0284C7',
  },
  radioDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
  },
  radioDotActive: {
    borderColor: '#0284C7',
    backgroundColor: '#0284C7',
  },
  summaryPillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  summaryPillLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748B',
    marginRight: 6,
  },
  summaryPillValue: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0F172A',
  },
  changeModelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  changeText: {
    fontSize: 11,
    color: '#0284C7',
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.5,
  },
  cardHelp: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 2,
  },
  input: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: '#0F172A',
    fontWeight: '700',
    marginTop: 10,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  backButton: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  backButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
  },
  primaryButton: {
    backgroundColor: '#0F172A',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 3,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
});
