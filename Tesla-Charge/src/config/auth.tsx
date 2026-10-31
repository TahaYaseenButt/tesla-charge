import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { db, auth, fetchFirestoreDoc } from './firebase';

export interface StationLocation {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  address?: string;
  updatedAt?: string;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string | null;
}

export interface LoginResult {
  success: boolean;
  isConfigured: boolean;
  error?: string;
}

interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: UserProfile | null;
  chargerId: string;
  chargerModel: string;
  stationLocation: StationLocation | null;
  isConfigured: boolean;
  tariffRate: number;
  currency: string;
  login: (email: string, pass: string, targetId?: string) => Promise<LoginResult>;
  register: (email: string, pass: string, targetId?: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  saveSetup: (model: string, id: string, loc: StationLocation | null) => Promise<void>;
  saveTariffRate: (rate: number, curr?: string) => Promise<void>;
  fetchRemoteConfig: (id: string) => Promise<{ model?: string; location?: StationLocation | null; isConfigured: boolean; tariffRate?: number; currency?: string }>;
}

const AuthContext = createContext<AuthContextType>({
  isAuthenticated: false,
  isLoading: true,
  user: null,
  chargerId: 'charger1',
  chargerModel: '',
  stationLocation: null,
  isConfigured: false,
  tariffRate: 125.0,
  currency: 'PKR',
  login: async () => ({ success: false, isConfigured: false }),
  register: async () => ({ success: false, isConfigured: false }),
  logout: async () => {},
  saveSetup: async () => {},
  saveTariffRate: async () => {},
  fetchRemoteConfig: async () => ({ isConfigured: false }),
});

const AUTH_KEY = '@tesla_charge_auth';
const USER_KEY = '@tesla_charge_user_profile';
const CHARGER_ID_KEY = '@tesla_charge_id';
const CHARGER_MODEL_KEY = '@tesla_charge_model';
const LOCATION_KEY = '@tesla_charge_location';
const TARIFF_KEY = '@tesla_charge_tariff_rate';
const CURRENCY_KEY = '@tesla_charge_currency';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [chargerId, setChargerId] = useState<string>('charger1');
  const [chargerModel, setChargerModel] = useState<string>('');
  const [stationLocation, setStationLocation] = useState<StationLocation | null>(null);
  const [isConfigured, setIsConfigured] = useState<boolean>(false);
  const [tariffRate, setTariffRate] = useState<number>(125.0);
  const [currency, setCurrency] = useState<string>('PKR');

  // Fetch remote config from Firestore for a given chargerId
  const fetchRemoteConfig = async (id: string) => {
    const cleanId = id.trim().toLowerCase() || 'charger1';
    try {
      // 1. Try fast HTTPS REST fetch which never hangs on WebChannel socket negotiation
      let data: Record<string, any> | null = await fetchFirestoreDoc('chargers', cleanId);

      // 2. If REST didn't return, fallback to SDK getDoc
      if (!data) {
        try {
          const snap = await getDoc(doc(db, 'chargers', cleanId));
          if (snap.exists()) {
            data = snap.data();
          }
        } catch {
          // SDK is offline or still negotiating transport
        }
      }

      if (data) {
        let configuredModel = data.displayModel || data.model;
        if (
          configuredModel === 'DC_EVSE' ||
          configuredModel === '220kW' ||
          configuredModel?.toLowerCase().includes('220') ||
          configuredModel?.toLowerCase().includes('240')
        ) {
          configuredModel = '240kW';
        }
        const configuredLocation = data.location || null;
        const configured = !!(data.model || data.displayModel || data.setupCompletedAt);
        const configuredTariff = data.tariffRate !== undefined ? Number(data.tariffRate) : undefined;
        const configuredCurrency = data.currency || undefined;

        if (configuredModel) {
          setChargerModel(configuredModel);
          await AsyncStorage.setItem(CHARGER_MODEL_KEY, configuredModel);
        }
        if (configuredLocation) {
          setStationLocation(configuredLocation);
          await AsyncStorage.setItem(LOCATION_KEY, JSON.stringify(configuredLocation));
        }
        if (configuredTariff !== undefined) {
          setTariffRate(configuredTariff);
          await AsyncStorage.setItem(TARIFF_KEY, String(configuredTariff));
        }
        if (configuredCurrency) {
          setCurrency(configuredCurrency);
          await AsyncStorage.setItem(CURRENCY_KEY, configuredCurrency);
        }
        if (configured) {
          setIsConfigured(true);
        }
        return {
          model: configuredModel,
          location: configuredLocation,
          isConfigured: configured,
          tariffRate: configuredTariff,
          currency: configuredCurrency,
        };
      }
    } catch {
      // Ignore network errors and continue with locally stored config
    }
    return { isConfigured: false };
  };

  const saveTariffRate = async (rate: number, curr?: string) => {
    const activeCurrency = curr || currency || 'PKR';
    setTariffRate(rate);
    setCurrency(activeCurrency);
    await AsyncStorage.setItem(TARIFF_KEY, String(rate));
    await AsyncStorage.setItem(CURRENCY_KEY, activeCurrency);

    const cleanId = chargerId?.trim().toLowerCase() || 'charger1';

    // Tenant Isolation Guard: Verify user is authorized for this charger before writing to Firestore
    if (user?.uid) {
      try {
        const uSnap = await getDoc(doc(db, 'users', user.uid));
        if (uSnap.exists()) {
          const uData = uSnap.data();
          const assignedStation = (uData.defaultChargerId || uData.stationId || '').trim().toLowerCase();
          if (assignedStation && assignedStation !== cleanId && uData.role !== 'admin') {
            console.warn(`[Tenant Isolation Alert] Blocked attempt by ${user.email} to modify station [${cleanId}]. User belongs to [${assignedStation}].`);
            return;
          }
        }
      } catch (_authCheckErr) {}
    }

    try {
      await setDoc(
        doc(db, 'chargers', cleanId),
        {
          chargePointId: cleanId,
          tariffRate: rate,
          currency: activeCurrency,
          tariffUpdatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    } catch (err: any) {
      console.warn('[Auth] Could not sync tariff rate to Firestore:', err.message);
    }
  };

  // Sync user profile to Firestore `users/{uid}` so each user has their own data record
  const syncUserProfileToFirestore = async (profile: UserProfile, stationId: string) => {
    try {
      await setDoc(
        doc(db, 'users', profile.uid),
        {
          uid: profile.uid,
          email: profile.email,
          lastLoginAt: new Date().toISOString(),
          lastUsedChargerId: stationId,
        },
        { merge: true }
      );
    } catch (err: any) {
      console.warn('[Auth] Could not sync user to Firestore:', err.message);
    }
  };

  useEffect(() => {
    let isMounted = true;

    (async () => {
      try {
        const storedAuth = await AsyncStorage.getItem(AUTH_KEY);
        const storedUser = await AsyncStorage.getItem(USER_KEY);
        const storedId = await AsyncStorage.getItem(CHARGER_ID_KEY);
        const storedModel = await AsyncStorage.getItem(CHARGER_MODEL_KEY);
        const storedLoc = await AsyncStorage.getItem(LOCATION_KEY);
        const storedTariff = await AsyncStorage.getItem(TARIFF_KEY);
        const storedCurrency = await AsyncStorage.getItem(CURRENCY_KEY);

        const activeId = storedId || 'charger1';
        if (isMounted) setChargerId(activeId);

        if (storedTariff && isMounted) setTariffRate(Number(storedTariff) || 125.0);
        if (storedCurrency && isMounted) setCurrency(storedCurrency);

        if (storedUser) {
          try {
            const parsed = JSON.parse(storedUser);
            if (isMounted) {
              setUser(parsed);
              setIsAuthenticated(true);
            }
          } catch (_) {}
        } else if (storedAuth === 'true') {
          if (isMounted) {
            setUser({ uid: 'admin_local', email: 'admin@local' });
            setIsAuthenticated(true);
          }
        }

        if (storedModel) {
          if (isMounted) {
            setChargerModel(storedModel);
            setIsConfigured(true);
          }
        }
        if (storedLoc) {
          try {
            if (isMounted) setStationLocation(JSON.parse(storedLoc));
          } catch (_) {}
        }

        // Query Firestore to get shared config saved by any user for this station
        const remote = await fetchRemoteConfig(activeId);
        if (remote.isConfigured || storedModel) {
          if (isMounted) setIsConfigured(true);
        }
      } catch (err) {
        console.error('Error restoring auth:', err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    })();

    // Listen to Firebase Auth state changes
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const profile: UserProfile = {
          uid: firebaseUser.uid,
          email: firebaseUser.email || '',
          displayName: firebaseUser.displayName,
        };
        if (isMounted) {
          setUser(profile);
          setIsAuthenticated(true);
        }
        await AsyncStorage.setItem(AUTH_KEY, 'true');
        await AsyncStorage.setItem(USER_KEY, JSON.stringify(profile));

        // CRITICAL TENANT ISOLATION: Fetch this user's assigned defaultChargerId from Firestore
        try {
          const userSnap = await getDoc(doc(db, 'users', firebaseUser.uid));
          if (userSnap.exists()) {
            const uData = userSnap.data();
            const userCharger = (uData.defaultChargerId || uData.stationId || '').trim().toLowerCase();
            if (userCharger && isMounted) {
              setChargerId(userCharger);
              await AsyncStorage.setItem(CHARGER_ID_KEY, userCharger);
              if (uData.defaultChargerModel) {
                setChargerModel(uData.defaultChargerModel);
                await AsyncStorage.setItem(CHARGER_MODEL_KEY, uData.defaultChargerModel);
              }
              setIsConfigured(true);
              fetchRemoteConfig(userCharger);
            }
          }
        } catch (_fetchErr) {}
      }
    });

    // Real-time synchronization of charger config (tariffRate, currency, model)
    let unsubCharger: (() => void) | undefined;
    const cleanId = (chargerId || 'charger1').trim().toLowerCase();
    try {
      unsubCharger = onSnapshot(
        doc(db, 'chargers', cleanId),
        (snap) => {
          if (snap.exists() && isMounted) {
            const d = snap.data();
            if (d.tariffRate !== undefined && d.tariffRate !== null) {
              const rate = Number(d.tariffRate);
              setTariffRate(rate);
              AsyncStorage.setItem(TARIFF_KEY, String(rate));
            }
            if (d.currency) {
              setCurrency(d.currency);
              AsyncStorage.setItem(CURRENCY_KEY, d.currency);
            }
            if (d.model) {
              setChargerModel(d.model);
            }
          }
        },
        () => {}
      );
    } catch {}

    return () => {
      isMounted = false;
      unsubscribe();
      if (unsubCharger) unsubCharger();
    };
  }, [chargerId]);

  const login = async (emailInput: string, passInput: string, targetId?: string): Promise<LoginResult> => {
    const email = emailInput.trim();
    const password = passInput;
    const activeId = targetId?.trim().toLowerCase() || chargerId || 'charger1';

    // 1. Admin shortcut fallback for offline / emergency access
    if (email.toLowerCase() === 'admin' && password === 'admin') {
      const adminProfile: UserProfile = {
        uid: 'admin_uid',
        email: 'admin@tesla-charge.local',
        displayName: 'Station Admin',
      };
      setIsAuthenticated(true);
      setUser(adminProfile);
      setChargerId(activeId);
      await AsyncStorage.setItem(AUTH_KEY, 'true');
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(adminProfile));
      await AsyncStorage.setItem(CHARGER_ID_KEY, activeId);

      const remote = await fetchRemoteConfig(activeId);
      const configured = remote.isConfigured || isConfigured || !!chargerModel;
      return { success: true, isConfigured: configured };
    }

    // 2. Real Firebase Email & Password Authentication
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const profile: UserProfile = {
        uid: cred.user.uid,
        email: cred.user.email || email,
        displayName: cred.user.displayName,
      };

      setIsAuthenticated(true);
      setUser(profile);
      setChargerId(activeId);

      await AsyncStorage.setItem(AUTH_KEY, 'true');
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(profile));
      await AsyncStorage.setItem(CHARGER_ID_KEY, activeId);

      // Record user profile in Firestore
      syncUserProfileToFirestore(profile, activeId);

      // Check if this specific user has completed charger setup
      let userConfigured = false;
      try {
        const userSnap = await getDoc(doc(db, 'users', profile.uid));
        if (userSnap.exists()) {
          const uData = userSnap.data();
          if (uData.setupCompleted && uData.defaultChargerId) {
            userConfigured = true;
            setChargerId(uData.defaultChargerId);
            if (uData.defaultChargerModel) {
              setChargerModel(uData.defaultChargerModel);
              await AsyncStorage.setItem(CHARGER_MODEL_KEY, uData.defaultChargerModel);
            }
            setIsConfigured(true);
            await AsyncStorage.setItem(CHARGER_ID_KEY, uData.defaultChargerId);
          }
        }
      } catch (_) {}

      if (!userConfigured) {
        setIsConfigured(false);
      }

      return { success: true, isConfigured: userConfigured };
    } catch (err: any) {
      let message = 'Unable to sign in. Please verify your credentials.';
      const code = err.code || '';
      if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
        message = 'Invalid email or password. Please check and try again.';
      } else if (code === 'auth/invalid-email') {
        message = 'Please enter a valid email address.';
      } else if (code === 'auth/user-disabled') {
        message = 'This user account has been disabled.';
      } else if (code === 'auth/too-many-requests') {
        message = 'Too many failed login attempts. Please wait a moment and try again.';
      } else if (err.message) {
        message = err.message;
      }
      return { success: false, isConfigured: false, error: message };
    }
  };

  const register = async (emailInput: string, passInput: string, targetId?: string): Promise<LoginResult> => {
    const email = emailInput.trim();
    const password = passInput;
    const activeId = targetId?.trim().toLowerCase() || chargerId || 'charger1';

    try {
      // Firebase createUserWithEmailAndPassword creates user and automatically signs them in
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      const profile: UserProfile = {
        uid: cred.user.uid,
        email: cred.user.email || email,
        displayName: cred.user.displayName,
      };

      setIsAuthenticated(true);
      setUser(profile);
      setChargerId(activeId);

      await AsyncStorage.setItem(AUTH_KEY, 'true');
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(profile));
      await AsyncStorage.setItem(CHARGER_ID_KEY, activeId);

      // Sync new user record to Firestore `users/{uid}`
      await setDoc(
        doc(db, 'users', profile.uid),
        {
          uid: profile.uid,
          email: profile.email,
          createdAt: new Date().toISOString(),
          lastLoginAt: new Date().toISOString(),
          role: 'driver',
          defaultChargerId: activeId,
          setupCompleted: false,
        },
        { merge: true }
      );

      // New accounts must always configure their station model and identifier
      setIsConfigured(false);
      return { success: true, isConfigured: false };
    } catch (err: any) {
      let message = 'Could not create account. Please try again.';
      const code = err.code || '';
      if (code === 'auth/email-already-in-use') {
        message = 'An account with this email already exists. Please Sign In instead.';
      } else if (code === 'auth/weak-password') {
        message = 'Password should be at least 6 characters.';
      } else if (code === 'auth/invalid-email') {
        message = 'Please enter a valid email address.';
      } else if (err.message) {
        message = err.message;
      }
      return { success: false, isConfigured: false, error: message };
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
    } catch (_) {}
    setIsAuthenticated(false);
    setUser(null);
    setChargerId('charger1');
    await AsyncStorage.multiRemove([
      AUTH_KEY,
      USER_KEY,
      CHARGER_ID_KEY,
      CHARGER_MODEL_KEY,
      LOCATION_KEY,
      TARIFF_KEY,
      CURRENCY_KEY,
    ]);
  };

  const saveSetup = async (model: string, id: string, loc: StationLocation | null) => {
    const cleanId = id.trim().toLowerCase() || 'charger1';
    const cleanModel = model.trim() || 'AC_ThreePhase21KW';

    setChargerId(cleanId);
    setChargerModel(cleanModel);
    setStationLocation(loc);
    setIsConfigured(true);

    await AsyncStorage.setItem(CHARGER_ID_KEY, cleanId);
    await AsyncStorage.setItem(CHARGER_MODEL_KEY, cleanModel);
    if (loc) {
      await AsyncStorage.setItem(LOCATION_KEY, JSON.stringify(loc));
    }

    // Save to Firestore so this user's profile remembers their configured station
    try {
      if (user?.uid) {
        await setDoc(
          doc(db, 'users', user.uid),
          {
            defaultChargerId: cleanId,
            defaultChargerModel: cleanModel,
            setupCompleted: true,
            setupCompletedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      }
      await setDoc(
        doc(db, 'chargers', cleanId),
        {
          chargePointId: cleanId,
          model: cleanModel,
          location: loc
            ? {
                ...loc,
                updatedAt: new Date().toISOString(),
              }
            : null,
          setupCompletedAt: new Date().toISOString(),
          configuredByUserId: user?.uid || 'anonymous',
          configuredByUserEmail: user?.email || 'anonymous',
        },
        { merge: true }
      );
    } catch (err: any) {
      console.warn('Could not sync setup to Firestore:', err.message);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isLoading,
        user,
        chargerId,
        chargerModel,
        stationLocation,
        isConfigured,
        tariffRate,
        currency,
        login,
        register,
        logout,
        saveSetup,
        saveTariffRate,
        fetchRemoteConfig,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
