import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
  Modal,
} from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { apiRequest } from '@/config/api';
import { useAuth } from '@/config/auth';
import {
  isNfcSupported,
  isNfcEnabled,
  openNfcSettings,
  scanNfcTag,
  validateOcppTag,
  NfcValidationResult,
} from '@/services/nfc';

interface RfidCardItem {
  idTag: string;
  formattedUid: string;
  label?: string;
  status: string;
  createdAt?: string;
  techType?: string;
}

export default function SettingsScreen() {
  const {
    chargerId,
    chargerModel,
    tariffRate: currentTariff,
    saveTariffRate,
    user,
    logout,
  } = useAuth();

  const CHARGER_ID = chargerId || 'charger1';
  const [rateInput, setRateInput] = useState<string>(String(currentTariff || 50));
  const [saving, setSaving] = useState<boolean>(false);
  const [saved, setSaved] = useState<boolean>(false);

  // Synchronize rateInput whenever currentTariff is loaded or updated
  useEffect(() => {
    if (currentTariff !== undefined && currentTariff !== null && currentTariff > 0) {
      setRateInput(String(currentTariff));
    }
  }, [currentTariff]);

  // RFID & NFC Cards State
  const [rfidCards, setRfidCards] = useState<RfidCardItem[]>([]);
  const [loadingCards, setLoadingCards] = useState<boolean>(true);
  const [modalVisible, setModalVisible] = useState<boolean>(false);
  const [scanning, setScanning] = useState<boolean>(false);
  const [scannedCard, setScannedCard] = useState<NfcValidationResult | null>(null);
  const [cardLabel, setCardLabel] = useState<string>('');
  const [savingCard, setSavingCard] = useState<boolean>(false);
  const [manualMode, setManualMode] = useState<boolean>(false);
  const [manualId, setManualId] = useState<string>('');

  // OTA Updates state
  const appVersion = Constants.expoConfig?.version || '1.0.1';
  const isOTAApplied = Boolean(Updates.isEmbeddedLaunch === false || Updates.updateId);
  const [checkingUpdate, setCheckingUpdate] = useState<boolean>(false);
  const [updateStatusText, setUpdateStatusText] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState<boolean>(false);

  // Fetch authorized RFID / NFC cards from server for this station
  const loadCards = useCallback(async () => {
    setLoadingCards(true);
    try {
      const res = await apiRequest(`/api/chargers/${CHARGER_ID}/rfid-tags`);
      if (res && res.tags) {
        const cards: RfidCardItem[] = res.tags.map((t: any) => {
          const tagId = t.tag_id || t.idTag;
          return {
            idTag: tagId,
            formattedUid: t.formatted_uid || (tagId.match(/.{1,2}/g)?.join(':') ?? tagId),
            label: t.user_email || 'Driver RFID Card',
            status: t.status || 'Accepted',
            createdAt: t.created_at,
            techType: 'ISO 14443-A',
          };
        });
        setRfidCards(cards);
      }
    } catch (err: any) {
      console.warn('Notice loading RFID tags:', err.message);
    } finally {
      setLoadingCards(false);
    }
  }, [CHARGER_ID]);

  useEffect(() => {
    loadCards();
  }, [loadCards]);

  const handleOpenNfcModal = async () => {
    setScannedCard(null);
    setCardLabel('');
    setManualId('');
    setManualMode(false);
    setModalVisible(true);
    triggerNfcScan();
  };

  const handleCloseNfcModal = () => {
    setModalVisible(false);
    setScanning(false);
    setScannedCard(null);
  };

  const triggerNfcScan = async () => {
    const supported = await isNfcSupported();
    if (!supported) {
      setManualMode(true);
      return;
    }

    const enabled = await isNfcEnabled();
    if (!enabled) {
      Alert.alert(
        'NFC is Disabled',
        'Please turn on NFC in your phone settings to tap cards, or enter the card UID manually.',
        [
          { text: 'Enter Manually', onPress: () => setManualMode(true) },
          { text: 'Open Settings', onPress: () => openNfcSettings() },
        ]
      );
      setManualMode(true);
      return;
    }

    setScanning(true);
    try {
      const tag = await scanNfcTag();
      if (tag && tag.id) {
        const result = validateOcppTag(tag.id, tag.techTypes);
        setScannedCard(result);
      }
    } catch (err: any) {
      console.warn('NFC read notice:', err.message);
    } finally {
      setScanning(false);
    }
  };

  const handleManualValidate = () => {
    const trimmed = manualId.trim();
    if (!trimmed) {
      Alert.alert('Required', 'Please enter a card UID.');
      return;
    }
    const result = validateOcppTag(trimmed);
    setScannedCard(result);
  };

  const handleSaveCardToServer = async () => {
    if (!scannedCard || !scannedCard.isValid) return;

    // Check if tag is already authorized on this charger
    const alreadyRegistered = rfidCards.some((c) => c.idTag === scannedCard.idTag);
    if (alreadyRegistered) {
      Alert.alert(
        'Card Already Registered',
        `Card [${scannedCard.formattedUid}] is already authorized for station ${CHARGER_ID.toUpperCase()}.`
      );
      return;
    }

    setSavingCard(true);
    try {
      const tagData = {
        idTag: scannedCard.idTag,
        formattedUid: scannedCard.formattedUid,
        label: cardLabel.trim() || `Card ${scannedCard.formattedUid.slice(-5)}`,
        status: 'Accepted',
        chargePointId: CHARGER_ID,
        createdAt: new Date().toISOString(),
        expiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
        createdBy: user?.email || 'operator',
        techType: scannedCard.techType || 'ISO 14443-A',
      };

      // Save card directly to the server database
      await apiRequest(`/api/chargers/${CHARGER_ID}/rfid-tags`, {
        method: 'POST',
        body: {
          tagId: scannedCard.idTag,
          userEmail: cardLabel.trim() || user?.email || 'Driver Card',
        },
      });

      await loadCards();
      setModalVisible(false);
      setScannedCard(null);

      Alert.alert(
        'NFC Card Authorized ✓',
        `Card [${scannedCard.formattedUid}] has been verified and added to the server.\n\nAny driver can now tap this physical card at station ${CHARGER_ID.toUpperCase()} to start charging.`
      );
    } catch (err: any) {
      Alert.alert('Failed to Save Card', err.message || 'Could not save card to server.');
    } finally {
      setSavingCard(false);
    }
  };

  const handleDeleteCard = (tagId: string, label: string) => {
    Alert.alert(
      'Revoke RFID Card',
      `Revoke ${label} [${tagId}]?\n\nThis card will no longer be authorized to start charging sessions on station ${CHARGER_ID.toUpperCase()}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            try {
              await apiRequest(`/api/chargers/${CHARGER_ID}/rfid-tags/${tagId}`, {
                method: 'DELETE',
              });
              await loadCards();
            } catch (err: any) {
              Alert.alert('Error', err.message || 'Could not revoke card.');
            }
          },
        },
      ]
    );
  };

  const handleCheckForUpdates = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    setUpdateStatusText('Searching for updates...');

    try {
      if (!Updates.isEnabled) {
        setTimeout(() => {
          setCheckingUpdate(false);
          setUpdateStatusText('OTA not baked into this build');
          Alert.alert(
            'OTA Updates Not Enabled in this APK',
            `Current Version: v${appVersion}\n\nThis specific APK was compiled before 'updates.url' was configured in app.json.\n\nTo enable instant over-the-air updates, simply rebuild the APK once using:\nnpx eas-cli@latest build -p android --profile preview --local`
          );
        }, 600);
        return;
      }

      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        setUpdateStatusText('Downloading update...');
        await Updates.fetchUpdateAsync();
        setUpdateReady(true);
        setUpdateStatusText('Update ready to install');
        Alert.alert(
          'Update Ready',
          `A new update (v1.0.1) has been downloaded.\n\nWhat's New:\n• Over-The-Air instant updates active & verified\n• Real-time dual 22kW connector sync\n• PKR electricity tariff precision\n\nRestart now to apply?`,
          [
            { text: 'Later', style: 'cancel' },
            {
              text: 'Restart Now',
              style: 'default',
              onPress: async () => {
                await Updates.reloadAsync();
              },
            },
          ]
        );
      } else {
        setUpdateStatusText('App is up to date ✓');
        Alert.alert('Up to Date', `Tesla Charge is running the latest version (v${appVersion}).`);
      }
    } catch (err: any) {
      console.warn('Update check failed:', err);
      setUpdateStatusText('Check failed');
      Alert.alert('Update Check', err?.message || 'Could not verify updates at this time.');
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleSave = async () => {
    const num = parseFloat(rateInput);
    if (isNaN(num) || num <= 0) {
      Alert.alert('Invalid Tariff', 'Please enter a valid price greater than 0.');
      return;
    }

    setSaving(true);
    setSaved(false);
    // Currency is strictly PKR
    await saveTariffRate(num, 'PKR');
    setSaving(false);
    setSaved(true);

    if (Platform.OS !== 'web') {
      Alert.alert('Saved', `Tariff updated to PKR ${num}/kWh.`);
    }

    setTimeout(() => setSaved(false), 3000);
  };

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>SETTINGS</Text>
        <Text style={styles.subtitle}>Station and billing preferences</Text>
      </View>

      {/* Electricity Tariff Card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Electricity Tariff</Text>
        <Text style={styles.cardDescription}>Set the electricity price per kilowatt-hour</Text>

        <View style={styles.inputRow}>
          <Text style={styles.currencyPrefix}>PKR</Text>
          <TextInput
            style={styles.input}
            keyboardType="decimal-pad"
            value={rateInput}
            onChangeText={(txt) => {
              setRateInput(txt);
              if (saved) setSaved(false);
            }}
            placeholder="50.00"
            placeholderTextColor="#94A3B8"
          />
          <Text style={styles.unitSuffix}>/ kWh</Text>
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, saved && styles.savedBtn]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.85}
        >
          {saving ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Text style={styles.saveBtnText}>{saved ? 'Saved ✓' : 'Save'}</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Station Information Card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Station Information</Text>

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Station ID</Text>
          <Text style={styles.infoValue}>{CHARGER_ID.toUpperCase()}</Text>
        </View>

        <View style={styles.divider} />

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Hardware Model</Text>
          <Text style={styles.infoValue}>
            {chargerModel === '30kW' || chargerModel === 'EVX_30KW'
              ? '30kW'
              : chargerModel === '240kW' ||
                chargerModel === '220kW' ||
                chargerModel === 'EVX_240KW' ||
                chargerModel?.toLowerCase().includes('240') ||
                chargerModel?.toLowerCase().includes('220') ||
                chargerModel === 'DC_EVSE'
              ? '240kW'
              : '60kW'}
          </Text>
        </View>

        <View style={styles.divider} />

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Protocol</Text>
          <Text style={styles.infoValue}>OCPP 1.6-J</Text>
        </View>

        <View style={styles.divider} />

        <TouchableOpacity
          style={styles.reconfigureBtn}
          onPress={() => router.push('/setup')}
          activeOpacity={0.85}
        >
          <Text style={styles.reconfigureBtnText}>Change Station ID or Hardware Model</Text>
        </TouchableOpacity>
      </View>

      {/* RFID & NFC Cards Card */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>RFID & NFC Cards</Text>
            <Text style={styles.cardDescription}>
              Authorize contactless cards to charge on this station
            </Text>
          </View>
        </View>

        {/* Add NFC Card Action Button */}
        <TouchableOpacity
          style={styles.addNfcBtn}
          onPress={handleOpenNfcModal}
          activeOpacity={0.85}
        >
          <Text style={styles.addNfcIcon}>📱</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.addNfcTitle}>Add NFC / RFID Card</Text>
            <Text style={styles.addNfcSubtitle}>Tap physical card on phone to authorize</Text>
          </View>
          <Text style={styles.addNfcArrow}>&rarr;</Text>
        </TouchableOpacity>

        {/* Authorized Cards List */}
        <View style={styles.tagsContainer}>
          <Text style={styles.tagsSectionLabel}>
            AUTHORIZED CARDS ({rfidCards.length})
          </Text>

          {loadingCards ? (
            <ActivityIndicator size="small" color="#0284C7" style={{ marginVertical: 12 }} />
          ) : rfidCards.length === 0 ? (
            <View style={styles.emptyTagsBox}>
              <Text style={styles.emptyTagsText}>No RFID cards registered yet.</Text>
              <Text style={styles.emptyTagsSub}>
                Tap "Add NFC / RFID Card" to authorize your first card.
              </Text>
            </View>
          ) : (
            rfidCards.map((card) => (
              <View key={card.idTag} style={styles.tagRow}>
                <View style={styles.tagIconBox}>
                  <Text style={styles.tagIcon}>💳</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.tagTitleRow}>
                    <Text style={styles.tagLabel}>{card.label || 'RFID Card'}</Text>
                    <View style={styles.tagBadge}>
                      <Text style={styles.tagBadgeText}>ACTIVE ✓</Text>
                    </View>
                  </View>
                  <Text style={styles.tagUid}>{card.formattedUid || card.idTag}</Text>
                </View>
                <TouchableOpacity
                  style={styles.deleteTagBtn}
                  onPress={() => handleDeleteCard(card.idTag, card.label || card.idTag)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.deleteTagText}>✕</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>
      </View>

      {/* App Version & Updates Card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>App Version & Updates</Text>
        <Text style={styles.cardDescription}>
          Over-the-air updates deliver instant improvements without reinstalling
        </Text>

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Installed Version</Text>
          <View style={styles.badgeRow}>
            <View style={styles.versionBadge}>
              <Text style={styles.versionBadgeText}>v{appVersion}</Text>
            </View>
            {isOTAApplied && (
              <View style={styles.otaActiveBadge}>
                <Text style={styles.otaActiveText}>OTA LATEST</Text>
              </View>
            )}
          </View>
        </View>

        <View style={styles.divider} />

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Update Status</Text>
          <Text style={[styles.statusText, (updateReady || isOTAApplied) ? styles.statusSuccess : null]}>
            {updateStatusText || (isOTAApplied ? `OTA v${appVersion} Active ✓` : 'Up to date')}
          </Text>
        </View>

        {/* What's New Box */}
        <View style={styles.whatsNewBox}>
          <View style={styles.whatsNewHeader}>
            <Text style={styles.whatsNewTitle}>What's New in v{appVersion}</Text>
            <View style={styles.whatsNewTag}>
              <Text style={styles.whatsNewTagText}>OTA UPDATE</Text>
            </View>
          </View>
          <View style={styles.changeItem}>
            <Text style={styles.changeBullet}>⚡</Text>
            <Text style={styles.changeText}>Over-The-Air instant updates verified</Text>
          </View>
          <View style={styles.changeItem}>
            <Text style={styles.changeBullet}>🔌</Text>
            <Text style={styles.changeText}>Real-time dual 22kW connector sync</Text>
          </View>
          <View style={styles.changeItem}>
            <Text style={styles.changeBullet}>🇵🇰</Text>
            <Text style={styles.changeText}>PKR electricity tariff precision</Text>
          </View>
        </View>

        {updateReady ? (
          <TouchableOpacity
            style={[styles.updateBtn, styles.restartBtn]}
            onPress={() => Updates.reloadAsync()}
            activeOpacity={0.85}
          >
            <Text style={styles.restartBtnText}>Restart to Apply Update</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.updateBtn, checkingUpdate && styles.disabledBtn]}
            onPress={handleCheckForUpdates}
            disabled={checkingUpdate}
            activeOpacity={0.85}
          >
            {checkingUpdate ? (
              <ActivityIndicator color="#0F172A" size="small" />
            ) : (
              <Text style={styles.updateBtnText}>Search for Updates</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* Account Card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Account</Text>

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Email</Text>
          <Text style={styles.infoValue}>{user?.email || 'driver@example.com'}</Text>
        </View>

        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout} activeOpacity={0.85}>
          <Text style={styles.logoutBtnText}>Log Out</Text>
        </TouchableOpacity>
      </View>

      {/* NFC Tap & Validate Modal */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={handleCloseNfcModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {scannedCard ? 'CARD VALIDATION' : 'SCAN NFC / RFID CARD'}
              </Text>
              <TouchableOpacity onPress={handleCloseNfcModal} style={styles.modalCloseBtn}>
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            {!scannedCard ? (
              /* Scanning state */
              <View style={styles.scanBody}>
                <View style={styles.nfcWaveContainer}>
                  <Text style={styles.nfcLargeIcon}>📱</Text>
                </View>

                <Text style={styles.scanInstruction}>
                  Hold Card to Phone
                </Text>
                <Text style={styles.scanSub}>
                  Place your RFID card or key fob firmly against the top or back of your phone.
                </Text>

                {scanning && (
                  <View style={styles.scanningBadge}>
                    <ActivityIndicator size="small" color="#0284C7" />
                    <Text style={styles.scanningText}>Listening for contactless card...</Text>
                  </View>
                )}

                {/* Manual entry fallback */}
                <TouchableOpacity
                  style={styles.manualToggleBtn}
                  onPress={() => setManualMode(!manualMode)}
                >
                  <Text style={styles.manualToggleText}>
                    {manualMode ? 'Switch to Tap Card' : 'Enter Card UID Manually'}
                  </Text>
                </TouchableOpacity>

                {manualMode && (
                  <View style={styles.manualBox}>
                    <TextInput
                      style={styles.manualInput}
                      placeholder="e.g. 04A1B2C3 / E4A28B10"
                      placeholderTextColor="#94A3B8"
                      value={manualId}
                      onChangeText={setManualId}
                      autoCapitalize="characters"
                    />
                    <TouchableOpacity
                      style={styles.manualSubmitBtn}
                      onPress={handleManualValidate}
                    >
                      <Text style={styles.manualSubmitText}>Validate &rarr;</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ) : (
              /* Validated Card State */
              <View style={styles.validatedBody}>
                {scannedCard.isValid ? (
                  <>
                    <View style={styles.validationSuccessBanner}>
                      <Text style={styles.validIcon}>✓</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.validTitle}>Compatible with Charger</Text>
                        <Text style={styles.validSub}>
                          Standard {scannedCard.techType || 'ISO 14443-A'} Contactless RFID
                        </Text>
                      </View>
                    </View>

                    <View style={styles.cardDetailsBox}>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>TAG UID</Text>
                        <Text style={styles.detailValue}>{scannedCard.formattedUid}</Text>
                      </View>
                      <View style={styles.divider} />
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>PROTOCOL</Text>
                        <Text style={styles.detailValue}>OCPP 1.6-J Token</Text>
                      </View>
                    </View>

                    <View style={styles.inputGroup}>
                      <Text style={styles.inputLabel}>CARD NAME / LABEL (OPTIONAL)</Text>
                      <TextInput
                        style={styles.labelInput}
                        placeholder="e.g. Driver Card 1 / Guest Tag"
                        placeholderTextColor="#94A3B8"
                        value={cardLabel}
                        onChangeText={setCardLabel}
                      />
                    </View>

                    <TouchableOpacity
                      style={styles.saveTagBtn}
                      onPress={handleSaveCardToServer}
                      disabled={savingCard}
                      activeOpacity={0.85}
                    >
                      {savingCard ? (
                        <ActivityIndicator color="#FFFFFF" />
                      ) : (
                        <Text style={styles.saveTagBtnText}>ADD TO SERVER &rarr;</Text>
                      )}
                    </TouchableOpacity>
                  </>
                ) : (
                  <View style={styles.validationErrorBanner}>
                    <Text style={styles.invalidIcon}>⚠️</Text>
                    <Text style={styles.invalidTitle}>Incompatible Card</Text>
                    <Text style={styles.invalidSub}>
                      {scannedCard.reason || 'Could not validate this tag with our charger.'}
                    </Text>
                    <TouchableOpacity
                      style={styles.retryBtn}
                      onPress={triggerNfcScan}
                    >
                      <Text style={styles.retryBtnText}>Scan Another Card</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}
          </View>
        </View>
      </Modal>
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
    gap: 16,
  },
  header: {
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: 1,
  },
  subtitle: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 2,
  },
  card: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 16,
    padding: 18,
  },
  cardHeaderRow: {
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 4,
  },
  cardDescription: {
    fontSize: 12,
    color: '#64748B',
    marginBottom: 16,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 50,
    marginBottom: 14,
  },
  currencyPrefix: {
    fontSize: 14,
    fontWeight: '800',
    color: '#475569',
    marginRight: 8,
  },
  input: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
    height: '100%',
  },
  unitSuffix: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748B',
    marginLeft: 8,
  },
  saveBtn: {
    backgroundColor: '#0F172A',
    borderRadius: 12,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  savedBtn: {
    backgroundColor: '#10B981',
  },
  saveBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  divider: {
    height: 1,
    backgroundColor: '#E2E8F0',
  },
  infoLabel: {
    fontSize: 13,
    color: '#64748B',
    fontWeight: '600',
  },
  infoValue: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
  },
  logoutBtn: {
    marginTop: 14,
    borderWidth: 1.5,
    borderColor: '#EF4444',
    borderRadius: 12,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoutBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#EF4444',
  },
  versionBadge: {
    backgroundColor: '#E2E8F0',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  versionBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0F172A',
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748B',
  },
  statusSuccess: {
    color: '#10B981',
    fontWeight: '700',
  },
  updateBtn: {
    marginTop: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: '#CBD5E1',
    borderRadius: 12,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabledBtn: {
    opacity: 0.6,
  },
  updateBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
  },
  restartBtn: {
    backgroundColor: '#10B981',
    borderColor: '#10B981',
  },
  restartBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  otaActiveBadge: {
    backgroundColor: '#DCFCE7',
    borderWidth: 1,
    borderColor: '#86EFAC',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  otaActiveText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#15803D',
    letterSpacing: 0.5,
  },
  whatsNewBox: {
    marginTop: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 12,
  },
  whatsNewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  whatsNewTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0F172A',
  },
  whatsNewTag: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  whatsNewTagText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#475569',
  },
  changeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginVertical: 2,
  },
  changeBullet: {
    fontSize: 12,
  },
  changeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#475569',
    flex: 1,
  },
  reconfigureBtn: {
    marginTop: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reconfigureBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0284C7',
  },
  addNfcBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0F172A',
    borderRadius: 14,
    padding: 14,
    gap: 12,
    marginTop: 4,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 2,
  },
  addNfcIcon: {
    fontSize: 24,
  },
  addNfcTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.2,
  },
  addNfcSubtitle: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  addNfcArrow: {
    fontSize: 16,
    fontWeight: '800',
    color: '#38BDF8',
  },
  tagsContainer: {
    marginTop: 16,
  },
  tagsSectionLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  emptyTagsBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 16,
    alignItems: 'center',
  },
  emptyTagsText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#475569',
  },
  emptyTagsSub: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 4,
    textAlign: 'center',
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 12,
    gap: 12,
    marginBottom: 8,
  },
  tagIconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagIcon: {
    fontSize: 18,
  },
  tagTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tagLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0F172A',
  },
  tagBadge: {
    backgroundColor: '#DCFCE7',
    borderWidth: 1,
    borderColor: '#86EFAC',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  tagBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#15803D',
  },
  tagUid: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  deleteTagBtn: {
    padding: 6,
  },
  deleteTagText: {
    fontSize: 14,
    color: '#94A3B8',
    fontWeight: '800',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 20,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '900',
    color: '#0F172A',
    letterSpacing: 0.5,
  },
  modalCloseBtn: {
    padding: 4,
  },
  modalCloseText: {
    fontSize: 16,
    color: '#64748B',
    fontWeight: '800',
  },
  scanBody: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  nfcWaveContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#F0F9FF',
    borderWidth: 2,
    borderColor: '#BAE6FD',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  nfcLargeIcon: {
    fontSize: 40,
  },
  scanInstruction: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0F172A',
    textAlign: 'center',
  },
  scanSub: {
    fontSize: 12,
    color: '#64748B',
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 18,
    paddingHorizontal: 10,
  },
  scanningBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#F0F9FF',
    borderWidth: 1,
    borderColor: '#BAE6FD',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 16,
  },
  scanningText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0284C7',
  },
  manualToggleBtn: {
    marginTop: 18,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  manualToggleText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0284C7',
  },
  manualBox: {
    width: '100%',
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  manualInput: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  manualSubmitBtn: {
    backgroundColor: '#0F172A',
    borderRadius: 10,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  manualSubmitText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  validatedBody: {
    gap: 14,
  },
  validationSuccessBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: '#BBF7D0',
    borderRadius: 12,
    padding: 12,
  },
  validIcon: {
    fontSize: 20,
    color: '#15803D',
    fontWeight: '900',
  },
  validTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#166534',
  },
  validSub: {
    fontSize: 11,
    color: '#15803D',
    marginTop: 1,
  },
  cardDetailsBox: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 12,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  detailLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748B',
  },
  detailValue: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0F172A',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  inputGroup: {
    gap: 6,
  },
  inputLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748B',
  },
  labelInput: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: '#0F172A',
    fontWeight: '600',
  },
  saveTagBtn: {
    backgroundColor: '#0F172A',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  saveTagBtnText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  validationErrorBanner: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FEE2E2',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  invalidIcon: {
    fontSize: 28,
    marginBottom: 6,
  },
  invalidTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#991B1B',
  },
  invalidSub: {
    fontSize: 12,
    color: '#B91C1C',
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 16,
  },
  retryBtn: {
    marginTop: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  retryBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#991B1B',
  },
});
