import { initializeApp, getApps } from "firebase/app";
import { initializeFirestore, Firestore, setLogLevel } from "firebase/firestore";
import { getDatabase, Database } from "firebase/database";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FirebaseAuth from "firebase/auth";

// Silence internal Firestore socket retry logs so transient reconnection notices don't trigger error screens
setLogLevel("silent");

export const firebaseConfig = {
  apiKey: "AIzaSyBkc0CoqaW1Mg5hLl7kpXU3TAURebEWpcg",
  authDomain: "fir-85543.firebaseapp.com",
  databaseURL: "https://fir-85543-default-rtdb.firebaseio.com",
  projectId: "fir-85543",
  storageBucket: "fir-85543.firebasestorage.app",
  messagingSenderId: "572566245138",
  appId: "1:572566245138:web:4ba404d2c1ac8788582dcb",
};

// Use a dedicated app instance with forced long-polling so stale [DEFAULT] instance never takes over
const APP_NAME = "tesla-charge-station";
const existingApp = getApps().find((a) => a.name === APP_NAME);
export const app = existingApp || initializeApp(firebaseConfig, APP_NAME);

declare global {
  var __tesla_charge_db__: Firestore | undefined;
}

if (!globalThis.__tesla_charge_db__) {
  globalThis.__tesla_charge_db__ = initializeFirestore(app, {
    experimentalForceLongPolling: true,
  });
}

// Firestore: permanent data (charger setup, transaction history, billing)
export const db: Firestore = globalThis.__tesla_charge_db__;

// Realtime Database: live data (online status, connector status, meter telemetry, active session)
export const rtdb: Database = getDatabase(app);

// Fix Issue 3: Use React Native AsyncStorage persistence so user is NOT logged out on app restart
// Metro automatically maps 'firebase/auth' to its React Native export where getReactNativePersistence exists.
const getRNPersistence = (FirebaseAuth as any).getReactNativePersistence;
let authInstance: FirebaseAuth.Auth;
try {
  if (typeof getRNPersistence === "function") {
    authInstance = (FirebaseAuth as any).initializeAuth(app, {
      persistence: getRNPersistence(AsyncStorage),
    });
  } else {
    authInstance = FirebaseAuth.getAuth(app);
  }
} catch {
  authInstance = FirebaseAuth.getAuth(app);
}
export const auth: FirebaseAuth.Auth = authInstance;

// Fix Issue 9: Consistent slug format to eliminate key collisions (e.g. A.1 vs A#1)
export const sanitizeChargerId = (id: string): string =>
  (id || "charger1")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");

/** RTDB path helper: live/{chargerId}/... (sanitizes all path parts to prevent illegal characters and collisions) */
export const livePath = (chargerId: string, ...parts: string[]): string => {
  const safeCharger = sanitizeChargerId(chargerId);
  const safeParts = parts.map((p) =>
    String(p)
      .trim()
      .replace(/[^a-z0-9_-]/gi, "-")
  );
  return ["live", safeCharger, ...safeParts].join("/");
};

/**
 * Fix Issue 1: Retrieve auto-refreshed user ID token so REST calls never fail after 1 hour.
 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  try {
    if (auth?.currentUser) {
      // getIdToken(false) automatically refreshes the token if expired or close to expiry
      const token = await auth.currentUser.getIdToken(false);
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }
  } catch {
    // If offline or anonymous, continue without bearer token
  }
  return headers;
}

/**
 * Utility to convert Firestore REST API response fields into a clean plain JavaScript object.
 */
export function parseFirestoreFields(fields: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  if (!fields) return result;
  for (const [key, val] of Object.entries(fields)) {
    if (val === null || val === undefined) {
      result[key] = null;
    } else if ("stringValue" in val) {
      result[key] = val.stringValue;
    } else if ("integerValue" in val) {
      result[key] = parseInt(val.integerValue, 10);
    } else if ("doubleValue" in val) {
      result[key] = Number(val.doubleValue);
    } else if ("booleanValue" in val) {
      result[key] = val.booleanValue;
    } else if ("timestampValue" in val) {
      result[key] = val.timestampValue;
    } else if ("nullValue" in val) {
      result[key] = null;
    } else if ("mapValue" in val) {
      result[key] = parseFirestoreFields(val.mapValue?.fields || {});
    } else if ("arrayValue" in val) {
      result[key] = (val.arrayValue?.values || []).map((v: any) => {
        if ("stringValue" in v) return v.stringValue;
        if ("integerValue" in v) return parseInt(v.integerValue, 10);
        if ("doubleValue" in v) return Number(v.doubleValue);
        if ("booleanValue" in v) return v.booleanValue;
        if ("mapValue" in v) return parseFirestoreFields(v.mapValue?.fields || {});
        return v;
      });
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Direct HTTPS REST fetch for Firestore documents with auto-refreshed auth header.
 */
export async function fetchFirestoreDoc(
  collectionName: string,
  docId: string
): Promise<Record<string, any> | null> {
  try {
    const headers = await getAuthHeaders();
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/${collectionName}/${encodeURIComponent(
      docId
    )}?key=${firebaseConfig.apiKey}`;
    const res = await fetch(url, {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return parseFirestoreFields(data.fields);
  } catch {
    return null;
  }
}

/**
 * Fix Issue 2: Direct HTTPS REST fetch with nextPageToken pagination loop
 * so it never truncates at 20 documents.
 */
export async function fetchFirestoreCollection(
  collectionName: string,
  maxDocs: number = 300
): Promise<Array<Record<string, any>>> {
  const results: Array<Record<string, any>> = [];
  let pageToken: string | null = null;

  try {
    const headers = await getAuthHeaders();
    do {
      let url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/${collectionName}?pageSize=100&key=${firebaseConfig.apiKey}`;
      if (pageToken) {
        url += `&pageToken=${encodeURIComponent(pageToken)}`;
      }
      const res = await fetch(url, {
        method: "GET",
        headers,
      });
      if (!res.ok) {
        break;
      }
      const data = await res.json();
      if (data.documents && Array.isArray(data.documents)) {
        for (const d of data.documents) {
          const id = d.name.split("/").pop();
          results.push({
            id,
            ...parseFirestoreFields(d.fields),
          });
        }
      }
      pageToken = data.nextPageToken || null;
    } while (pageToken && results.length < maxDocs);
  } catch (err: any) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[Firebase REST] Collection fetch notice:", err.message);
    }
  }

  return results;
}


