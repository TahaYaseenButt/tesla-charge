import { Platform } from 'react-native';

// Safe dynamic import to prevent crashes in Expo Go, Web, or Simulators
let NfcManager: any = null;
let NfcTech: any = { NfcA: 'NfcA', IsoDep: 'IsoDep', Ndef: 'Ndef' };

try {
  const nfcModule = require('react-native-nfc-manager');
  NfcManager = nfcModule.default || nfcModule;
  if (nfcModule.NfcTech) {
    NfcTech = nfcModule.NfcTech;
  }
} catch {
  // Gracefully null when running inside Expo Go or environments without the native module
  NfcManager = null;
}

export interface NfcTagEvent {
  id?: string;
  techTypes?: string[];
  [key: string]: any;
}

export interface NfcValidationResult {
  isValid: boolean;
  idTag: string;
  formattedUid: string;
  techType?: string;
  reason?: string;
}

/**
 * Check if the device hardware supports NFC
 */
export async function isNfcSupported(): Promise<boolean> {
  if (Platform.OS === 'web' || !NfcManager) return false;
  try {
    const supported = await NfcManager.isSupported();
    return Boolean(supported);
  } catch {
    return false;
  }
}

/**
 * Check if NFC is currently turned on in device settings
 */
export async function isNfcEnabled(): Promise<boolean> {
  if (Platform.OS === 'web' || !NfcManager) return false;
  try {
    const enabled = await NfcManager.isEnabled();
    return Boolean(enabled);
  } catch {
    return false;
  }
}

/**
 * Open the native system NFC settings page (Android)
 */
export async function openNfcSettings(): Promise<void> {
  if (Platform.OS === 'android' && NfcManager) {
    try {
      await NfcManager.goToNfcSetting();
    } catch (_) {}
  }
}

/**
 * Initialize NFC manager
 */
export async function initNfc(): Promise<boolean> {
  if (Platform.OS === 'web' || !NfcManager) return false;
  try {
    await NfcManager.start();
    return true;
  } catch (err) {
    console.warn('NFC initialization notice:', err);
    return false;
  }
}

/**
 * Scan for an NFC / RFID card tapped against the phone
 */
export async function scanNfcTag(): Promise<NfcTagEvent | null> {
  if (Platform.OS === 'web' || !NfcManager) return null;

  try {
    await initNfc();

    if (Platform.OS === 'android') {
      // On Android, registerTagEvent enables Android Foreground Dispatch
      // so the app captures the card directly before the system default app
      return await new Promise<NfcTagEvent | null>((resolve) => {
        let isDone = false;
        const cleanup = () => {
          if (isDone) return;
          isDone = true;
          try {
            NfcManager.setEventListener('NfcManagerDiscoverTag', null);
            NfcManager.unregisterTagEvent().catch(() => {});
          } catch (_) {}
        };

        const timeout = setTimeout(() => {
          cleanup();
          resolve(null);
        }, 25000); // 25s window for user to tap

        try {
          NfcManager.setEventListener('NfcManagerDiscoverTag', (tag: any) => {
            clearTimeout(timeout);
            cleanup();
            resolve(tag);
          });

          NfcManager.registerTagEvent().catch(() => {
            // Fallback to requestTechnology if registerTagEvent fails
            NfcManager.requestTechnology([NfcTech.NfcA, NfcTech.IsoDep, NfcTech.Ndef])
              .then(() => NfcManager.getTag())
              .then((t: any) => {
                clearTimeout(timeout);
                cleanup();
                resolve(t);
              })
              .catch(() => {
                clearTimeout(timeout);
                cleanup();
                resolve(null);
              });
          });
        } catch (e) {
          clearTimeout(timeout);
          cleanup();
          resolve(null);
        }
      });
    } else {
      // iOS CoreNFC
      await NfcManager.requestTechnology([NfcTech.NfcA, NfcTech.IsoDep, NfcTech.Ndef], {
        alertMessage: 'Hold your RFID card near the top of your iPhone.',
      });
      const tag = await NfcManager.getTag();
      return tag;
    }
  } catch (err) {
    console.warn('NFC scan error:', err);
    return null;
  } finally {
    try {
      if (NfcManager) {
        await NfcManager.cancelTechnologyRequest();
        await NfcManager.unregisterTagEvent();
      }
    } catch (_) {}
  }
}

/**
 * Validate if the scanned tag satisfies OCPP 1.6 / charger requirements
 */
export function validateOcppTag(rawId: string, techTypes?: string[]): NfcValidationResult {
  const cleanId = rawId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

  if (!cleanId) {
    return {
      isValid: false,
      idTag: '',
      formattedUid: '',
      reason: 'No tag ID could be read from this card.',
    };
  }

  // OCPP 1.6 IdToken constraint: max 20 characters, min 4 characters
  if (cleanId.length < 4) {
    return {
      isValid: false,
      idTag: cleanId,
      formattedUid: cleanId,
      reason: 'Tag ID is too short (must be at least 4 characters).',
    };
  }

  if (cleanId.length > 20) {
    return {
      isValid: false,
      idTag: cleanId,
      formattedUid: cleanId,
      reason: 'Tag ID exceeds maximum OCPP 1.6 length (20 characters).',
    };
  }

  // Format as readable hex pairs (e.g. 04:A1:B2:C3)
  const formattedUid = cleanId.match(/.{1,2}/g)?.join(':') || cleanId;
  const tech = techTypes && techTypes.length > 0 ? techTypes[0].split('.').pop() : 'ISO 14443-A';

  return {
    isValid: true,
    idTag: cleanId,
    formattedUid,
    techType: tech,
  };
}
