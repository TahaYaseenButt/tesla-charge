import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiRequest, setAuthToken, getAuthToken } from './api';

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

    // 2. Direct Server Login (Local JWT)
    try {
      const res = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      });

      if (res && res.success && res.token) {
        await setAuthToken(res.token);

        // Derive user station strictly from server mapping or fallback target
        const userStation = (res.user.stationId || res.user.defaultChargerId || targetId || 'charger1').trim().toLowerCase();

        const profile: UserProfile = {
          uid: res.user.uid || res.user.id,
          email: res.user.email,
          displayName: res.user.displayName || email.split('@')[0],
          stationId: userStation,
          defaultChargerId: userStation,
          role: res.user.role,
        };

        setIsAuthenticated(true);
        setUser(profile);
        setChargerId(userStation);
        setIsConfigured(true);

        await AsyncStorage.setItem(AUTH_KEY, 'true');
        await AsyncStorage.setItem(USER_KEY, JSON.stringify(profile));
        await AsyncStorage.setItem(CHARGER_ID_KEY, userStation);

        await fetchRemoteConfig(userStation);

        return { success: true, isConfigured: true };
      }
      return { success: false, isConfigured: false, error: res?.error || 'Login failed.' };
    } catch (err: any) {
      return { success: false, isConfigured: false, error: err.message || 'Unable to connect to server.' };
    }
  };

  const register = async (emailInput: string, passInput: string, targetId?: string): Promise<LoginResult> => {
    const email = emailInput.trim();
    const password = passInput;
    const requestedStation = (targetId || 'charger1').trim().toLowerCase();

    try {
      const res = await apiRequest('/api/auth/register', {
        method: 'POST',
        body: { email, password, displayName: email.split('@')[0], stationId: requestedStation },
      });

      if (res && res.success && res.token) {
        await setAuthToken(res.token);

        const assignedStation = (res.user.stationId || requestedStation).trim().toLowerCase();

        const profile: UserProfile = {
          uid: res.user.uid || res.user.id,
          email: res.user.email,
          displayName: res.user.displayName,
          stationId: assignedStation,
          defaultChargerId: assignedStation,
        };

        setIsAuthenticated(true);
        setUser(profile);
        setChargerId(assignedStation);
        setIsConfigured(true);

        await AsyncStorage.setItem(AUTH_KEY, 'true');
        await AsyncStorage.setItem(USER_KEY, JSON.stringify(profile));
        await AsyncStorage.setItem(CHARGER_ID_KEY, assignedStation);

        await fetchRemoteConfig(assignedStation);

        return { success: true, isConfigured: true };
      }
      return { success: false, isConfigured: false, error: res?.error || 'Registration failed.' };
    } catch (err: any) {
      return { success: false, isConfigured: false, error: err.message || 'Unable to register account.' };
    }
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
