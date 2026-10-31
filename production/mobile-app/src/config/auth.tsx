import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiRequest, setAuthToken, getAuthToken } from './api';
import { firebaseConfig, parseFirestoreFields } from './firebase';

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
  stationId?: string;
  defaultChargerId?: string;
  defaultChargerModel?: string;
  role?: string;
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
  const [chargerModel, setChargerModel] = useState<string>('240kW');
  const [stationLocation, setStationLocation] = useState<StationLocation | null>(null);
  const [isConfigured, setIsConfigured] = useState<boolean>(true);
  const [tariffRate, setTariffRate] = useState<number>(125.0);
  const [currency, setCurrency] = useState<string>('PKR');

  const fetchRemoteConfig = async (id: string) => {
    const cleanId = (id || 'charger1').trim().toLowerCase();

    // 1. Try local/remote /api/chargers/:id
    try {
      const data = await apiRequest(`/api/chargers/${cleanId}`);
      if (data && data.charger) {
        const rate = Number(data.charger.tariffRate || 125);
        setTariffRate(rate);
        if (data.charger.currency) setCurrency(data.charger.currency);
        if (data.charger.model) setChargerModel(data.charger.model);

        return {
          model: data.charger.model || '240kW',
          location: data.charger.location || null,
          isConfigured: true,
          tariffRate: rate,
          currency: data.charger.currency || 'PKR',
        };
      }
    } catch (_err) {}

    // 2. Try /api/chargers/:id/live (which remote server serves)
    try {
      const data = await apiRequest(`/api/chargers/${cleanId}/live`);
      if (data && data.charger) {
        const rate = Number(data.charger.tariffRate || 125);
        setTariffRate(rate);
        if (data.charger.currency) setCurrency(data.charger.currency);
        if (data.charger.model) setChargerModel(data.charger.model);

        return {
          model: data.charger.model || '240kW',
          location: data.charger.location || null,
          isConfigured: true,
          tariffRate: rate,
          currency: data.charger.currency || 'PKR',
        };
      }
    } catch (_err) {}

    // 3. Fallback to direct Firestore REST API
    try {
      const res = await fetch(
        `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/chargers/${encodeURIComponent(cleanId)}`
      );
      if (res.ok) {
        const docJson = await res.json();
        const d = parseFirestoreFields(docJson.fields || {});
        const rate = Number(d.tariffRate || 125);
        setTariffRate(rate);
        if (d.currency) setCurrency(d.currency);
        if (d.model) setChargerModel(d.model);

        return {
          model: d.model || '240kW',
          location: d.location || null,
          isConfigured: true,
          tariffRate: rate,
          currency: d.currency || 'PKR',
        };
      }
    } catch (_err) {}

    return { isConfigured: true, tariffRate: 125, currency: 'PKR', model: '240kW' };
  };

  useEffect(() => {
    let isMounted = true;

    (async () => {
      try {
        const [storedAuth, storedUser, storedId, storedModel, storedLoc, storedTariff, storedCurr] =
          await Promise.all([
            AsyncStorage.getItem(AUTH_KEY),
            AsyncStorage.getItem(USER_KEY),
            AsyncStorage.getItem(CHARGER_ID_KEY),
            AsyncStorage.getItem(CHARGER_MODEL_KEY),
            AsyncStorage.getItem(LOCATION_KEY),
            AsyncStorage.getItem(TARIFF_KEY),
            AsyncStorage.getItem(CURRENCY_KEY),
          ]);

        let parsedUser: UserProfile | null = null;
        if (storedUser) {
          try {
            parsedUser = JSON.parse(storedUser);
          } catch {}
        }

        // Determine active charger: prioritize user's bound stationId, then storedId
        const boundStation = parsedUser?.stationId || parsedUser?.defaultChargerId;
        const activeId = boundStation ? boundStation.trim().toLowerCase() : (storedId ? storedId.trim().toLowerCase() : 'charger1');

        if (isMounted) {
          setChargerId(activeId);
          if (storedModel) setChargerModel(storedModel);
          if (storedLoc) {
            try { setStationLocation(JSON.parse(storedLoc)); } catch {}
          }
          if (storedTariff) setTariffRate(parseFloat(storedTariff) || 125.0);
          if (storedCurr) setCurrency(storedCurr);
        }

        const token = await getAuthToken();
        if (token && storedAuth === 'true' && parsedUser) {
          if (isMounted) {
            setUser(parsedUser);
            setIsAuthenticated(true);
          }
        }

        await fetchRemoteConfig(activeId);
        if (isMounted) setIsConfigured(true);
      } catch (err) {
        console.error('Error restoring auth:', err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  const login = async (emailInput: string, passInput: string, targetId?: string): Promise<LoginResult> => {
    const email = emailInput.trim();
    const password = passInput;

    // 1. Offline admin emergency fallback
    if (email.toLowerCase() === 'admin' && password === 'admin') {
      const activeId = targetId?.trim().toLowerCase() || 'charger1';
      const adminProfile: UserProfile = {
        uid: 'admin_local',
        email: 'admin@tesla-charge.local',
        displayName: 'Station Admin',
        stationId: activeId,
      };
      setIsAuthenticated(true);
      setUser(adminProfile);
      setChargerId(activeId);
      setIsConfigured(true);
      await AsyncStorage.setItem(AUTH_KEY, 'true');
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(adminProfile));
      await AsyncStorage.setItem(CHARGER_ID_KEY, activeId);
      return { success: true, isConfigured: true };
    }

    let loginSuccess = false;
    let userProfile: UserProfile | null = null;
    let tokenToStore: string | null = null;
    let lastError: string = 'Unable to connect to server.';

    // 2. Try Direct Server Login (Local JWT or server /api/auth/login)
    try {
      const res = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { email, password },
        timeoutMs: 4000,
      });

      if (res && res.success && res.token && res.user) {
        loginSuccess = true;
        tokenToStore = res.token;
        const userStation = (res.user.stationId || res.user.defaultChargerId || targetId || 'charger1').trim().toLowerCase();
        userProfile = {
          uid: res.user.uid || res.user.id,
          email: res.user.email,
          displayName: res.user.displayName || email.split('@')[0],
          stationId: userStation,
          defaultChargerId: userStation,
          defaultChargerModel: res.user.defaultChargerModel,
          role: res.user.role,
        };
      } else if (res?.error) {
        lastError = res.error;
      }
    } catch (err: any) {
      if (err.message && err.message.includes('401')) {
        lastError = 'Invalid email or password. Please check your credentials.';
      } else {
        lastError = err.message || 'Server unavailable.';
      }
    }

    // 3. Fallback to Firebase Auth REST if server auth did not succeed (e.g. 404 on tesla-charge.online)
    if (!loginSuccess) {
      try {
        const fbRes = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, returnSecureToken: true }),
          }
        );

        const fbData = await fbRes.json().catch(() => ({}));

        if (fbRes.ok && fbData.idToken && fbData.localId) {
          loginSuccess = true;
          tokenToStore = fbData.idToken;
          const uid = fbData.localId;
          const userEmail = fbData.email || email;

          // Fetch user document from Firestore REST to get assigned stationId & model
          let assignedStation = (targetId || '').trim().toLowerCase();
          let assignedModel = '';

          try {
            const userDocRes = await fetch(
              `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/users/${uid}`,
              {
                headers: {
                  Authorization: `Bearer ${fbData.idToken}`,
                  Accept: 'application/json',
                },
              }
            );

            if (userDocRes.ok) {
              const docData = await userDocRes.json();
              const fields = parseFirestoreFields(docData.fields || {});
              if (fields.defaultChargerId || fields.stationId) {
                assignedStation = (fields.defaultChargerId || fields.stationId).trim().toLowerCase();
              }
              if (fields.defaultChargerModel) {
                assignedModel = fields.defaultChargerModel;
              }
            }
          } catch (_e) {}

          // Fallback defaults based on known users if not retrieved
          if (!assignedStation) {
            if (email.toLowerCase().includes('hafeez')) {
              assignedStation = 'aziz light and solar';
              assignedModel = assignedModel || '60kW';
            } else {
              assignedStation = 'charger1';
              assignedModel = assignedModel || '240kW';
            }
          }

          userProfile = {
            uid,
            email: userEmail,
            displayName: fbData.displayName || userEmail.split('@')[0],
            stationId: assignedStation,
            defaultChargerId: assignedStation,
            defaultChargerModel: assignedModel,
            role: 'driver',
          };
        } else {
          const errMsg = fbData?.error?.message || '';
          if (
            errMsg === 'EMAIL_NOT_FOUND' ||
            errMsg === 'INVALID_PASSWORD' ||
            errMsg === 'INVALID_LOGIN_CREDENTIALS'
          ) {
            return {
              success: false,
              isConfigured: false,
              error: 'Invalid email or password. Please check your credentials.',
            };
          } else if (errMsg === 'USER_DISABLED') {
            return {
              success: false,
              isConfigured: false,
              error: 'This user account has been disabled.',
            };
          } else if (errMsg === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
            return {
              success: false,
              isConfigured: false,
              error: 'Too many attempts. Please try again later.',
            };
          } else if (errMsg) {
            return {
              success: false,
              isConfigured: false,
              error: errMsg,
            };
          }
        }
      } catch (fbErr: any) {
        lastError = fbErr.message || lastError;
      }
    }

    if (loginSuccess && userProfile) {
      if (tokenToStore) {
        await setAuthToken(tokenToStore);
      }

      setIsAuthenticated(true);
      setUser(userProfile);
      setChargerId(userProfile.stationId || 'charger1');
      if (userProfile.defaultChargerModel) {
        setChargerModel(userProfile.defaultChargerModel);
      }
      setIsConfigured(true);

      await AsyncStorage.setItem(AUTH_KEY, 'true');
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(userProfile));
      await AsyncStorage.setItem(CHARGER_ID_KEY, userProfile.stationId || 'charger1');
      if (userProfile.defaultChargerModel) {
        await AsyncStorage.setItem(CHARGER_MODEL_KEY, userProfile.defaultChargerModel);
      }

      await fetchRemoteConfig(userProfile.stationId || 'charger1');

      return { success: true, isConfigured: true };
    }

    return {
      success: false,
      isConfigured: false,
      error: lastError || 'Invalid credentials or unable to reach auth server.',
    };
  };

  const register = async (emailInput: string, passInput: string, targetId?: string): Promise<LoginResult> => {
    const email = emailInput.trim();
    const password = passInput;
    const requestedStation = (targetId || 'charger1').trim().toLowerCase();

    let registerSuccess = false;
    let userProfile: UserProfile | null = null;
    let tokenToStore: string | null = null;
    let lastError: string = 'Unable to register account.';

    // 1. Try local/remote backend server /api/auth/register
    try {
      const res = await apiRequest('/api/auth/register', {
        method: 'POST',
        body: { email, password, displayName: email.split('@')[0], stationId: requestedStation },
        timeoutMs: 4000,
      });

      if (res && res.success && res.token && res.user) {
        registerSuccess = true;
        tokenToStore = res.token;
        const assignedStation = (res.user.stationId || requestedStation).trim().toLowerCase();
        userProfile = {
          uid: res.user.uid || res.user.id,
          email: res.user.email,
          displayName: res.user.displayName,
          stationId: assignedStation,
          defaultChargerId: assignedStation,
        };
      } else if (res?.error) {
        lastError = res.error;
      }
    } catch (err: any) {
      if (err.message && err.message.includes('409')) {
        return { success: false, isConfigured: false, error: 'User with this email already exists.' };
      }
    }

    // 2. Fallback to Firebase Auth REST if server register not supported (e.g. 404 on tesla-charge.online)
    if (!registerSuccess) {
      try {
        const fbRes = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${firebaseConfig.apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, returnSecureToken: true }),
          }
        );

        const fbData = await fbRes.json().catch(() => ({}));

        if (fbRes.ok && fbData.idToken && fbData.localId) {
          registerSuccess = true;
          tokenToStore = fbData.idToken;
          const uid = fbData.localId;
          const userEmail = fbData.email || email;

          // Record new user in Firestore REST
          try {
            await fetch(
              `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/users/${uid}`,
              {
                method: 'PATCH',
                headers: {
                  Authorization: `Bearer ${tokenToStore}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  fields: {
                    uid: { stringValue: uid },
                    email: { stringValue: userEmail },
                    stationId: { stringValue: requestedStation },
                    defaultChargerId: { stringValue: requestedStation },
                    role: { stringValue: 'driver' },
                    setupCompleted: { booleanValue: true },
                    createdAt: { stringValue: new Date().toISOString() },
                    lastLoginAt: { stringValue: new Date().toISOString() },
                  },
                }),
              }
            );
          } catch (_e) {}

          userProfile = {
            uid,
            email: userEmail,
            displayName: userEmail.split('@')[0],
            stationId: requestedStation,
            defaultChargerId: requestedStation,
          };
        } else {
          const errMsg = fbData?.error?.message || '';
          if (errMsg === 'EMAIL_EXISTS') {
            return {
              success: false,
              isConfigured: false,
              error: 'An account with this email address already exists. Please log in.',
            };
          } else if (errMsg.includes('WEAK_PASSWORD')) {
            return {
              success: false,
              isConfigured: false,
              error: 'Password should be at least 6 characters.',
            };
          } else if (errMsg) {
            return {
              success: false,
              isConfigured: false,
              error: errMsg,
            };
          }
        }
      } catch (fbErr: any) {
        lastError = fbErr.message || lastError;
      }
    }

    if (registerSuccess && userProfile) {
      if (tokenToStore) {
        await setAuthToken(tokenToStore);
      }

      setIsAuthenticated(true);
      setUser(userProfile);
      setChargerId(userProfile.stationId || 'charger1');
      setIsConfigured(true);

      await AsyncStorage.setItem(AUTH_KEY, 'true');
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(userProfile));
      await AsyncStorage.setItem(CHARGER_ID_KEY, userProfile.stationId || 'charger1');

      await fetchRemoteConfig(userProfile.stationId || 'charger1');

      return { success: true, isConfigured: true };
    }

    return {
      success: false,
      isConfigured: false,
      error: lastError || 'Unable to register account. Please check your credentials.',
    };
  };

  const logout = async () => {
    setIsAuthenticated(false);
    setUser(null);
    setChargerId('charger1');
    await setAuthToken(null);
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
    const cleanId = (id || 'charger1').trim().toLowerCase();
    setChargerModel(model);
    setChargerId(cleanId);
    setStationLocation(loc);
    setIsConfigured(true);

    await Promise.all([
      AsyncStorage.setItem(CHARGER_MODEL_KEY, model),
      AsyncStorage.setItem(CHARGER_ID_KEY, cleanId),
      loc ? AsyncStorage.setItem(LOCATION_KEY, JSON.stringify(loc)) : AsyncStorage.removeItem(LOCATION_KEY),
    ]);
  };

  const saveTariffRate = async (rate: number, curr: string = 'PKR') => {
    const r = Math.max(0, rate);
    const activeTarget = (chargerId || user?.stationId || 'charger1').trim().toLowerCase();
    setTariffRate(r);
    setCurrency(curr);
    await AsyncStorage.setItem(TARIFF_KEY, String(r));
    await AsyncStorage.setItem(CURRENCY_KEY, curr);

    try {
      await apiRequest(`/api/chargers/${encodeURIComponent(activeTarget)}/tariff`, {
        method: 'POST',
        body: { tariffRate: r },
      });
    } catch (_e) {}
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
