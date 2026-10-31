import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_SERVER_KEY = '@tesla_charge_server_url';
const STORAGE_TOKEN_KEY = '@tesla_charge_jwt_token';
const DEFAULT_SERVER_URL = 'https://tesla-charge.online';

export async function getServerUrl(): Promise<string> {
  try {
    const saved = await AsyncStorage.getItem(STORAGE_SERVER_KEY);
    return saved && saved.trim() ? saved.trim() : DEFAULT_SERVER_URL;
  } catch {
    return DEFAULT_SERVER_URL;
  }
}

export async function setServerUrl(url: string): Promise<void> {
  const clean = url.trim().replace(/\/+$/, '');
  await AsyncStorage.setItem(STORAGE_SERVER_KEY, clean);
}

export async function getAuthToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(STORAGE_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function setAuthToken(token: string | null): Promise<void> {
  if (token) {
    await AsyncStorage.setItem(STORAGE_TOKEN_KEY, token);
  } else {
    await AsyncStorage.removeItem(STORAGE_TOKEN_KEY);
  }
}

/**
 * Universal HTTP client with automatic Authorization header
 */
export async function apiRequest<T = any>(
  path: string,
  options: {
    method?: string;
    body?: any;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const baseUrl = await getServerUrl();
  const token = await getAuthToken();
  const url = `${baseUrl}${path.startsWith('/') ? path : '/' + path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 12000);

  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
    }

    return data;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('Server request timed out. Please check your network connection.');
    }
    throw err;
  }
}

/**
 * Direct Live Telemetry Stream (SSE / Polling Fallback)
 * Supports passing target chargerId for strict tenant data isolation
 */
export function subscribeToLiveStatus(
  chargerIdOrCb: string | ((data: any) => void),
  onDataOrErr?: ((data: any) => void) | ((err: any) => void),
  onError?: (err: any) => void
): () => void {
  let cleanId = 'charger1';
  let onData: (data: any) => void;
  let errCb: ((err: any) => void) | undefined;

  if (typeof chargerIdOrCb === 'string') {
    cleanId = chargerIdOrCb.trim().toLowerCase() || 'charger1';
    onData = onDataOrErr as (data: any) => void;
    errCb = onError;
  } else {
    onData = chargerIdOrCb;
    errCb = onDataOrErr as (err: any) => void;
  }

  let isSubscribed = true;
  let intervalId: any = null;

  async function poll() {
    if (!isSubscribed) return;
    try {
      const res = await apiRequest(`/api/status?chargerId=${encodeURIComponent(cleanId)}`, { timeoutMs: 5000 });
      if (res && isSubscribed && onData) {
        onData(res);
      }
    } catch (err) {
      if (errCb && isSubscribed) errCb(err);
    }
  }

  // Initial immediate fetch
  poll();
  // Fast high-frequency polling (every 2.5 seconds, direct to server with minimal bandwidth)
  intervalId = setInterval(poll, 2500);

  return () => {
    isSubscribed = false;
    if (intervalId) clearInterval(intervalId);
  };
}
