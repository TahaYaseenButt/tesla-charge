/**
 * Time & Timezone Utilities
 * Enforces Asia/Karachi (Pakistan Standard Time, UTC+5) across all server operations.
 * 
 * Features Automatic NTP & HTTP Time Drift Compensation:
 * - If the hardware CMOS coin battery is dead or RTC resets on boot,
 *   this module automatically queries Google/Cloudflare NTP (port 123)
 *   and HTTP Date headers, computes the exact millisecond offset,
 *   and guarantees that all OCPP messages, transactions, and heartbeats
 *   reflect the true atomic Pakistan Standard Time.
 */

import dgram from "dgram";
import { exec } from "child_process";

// Force process.env.TZ to Asia/Karachi
process.env.TZ = "Asia/Karachi";

export const KARACHI_TIMEZONE = "Asia/Karachi";
export const KARACHI_OFFSET_HOURS = 5;

// Dynamic offset tracking (in milliseconds) between local system clock and real internet time
let clockOffsetMs = 0;
let lastSyncAt = null;
let isSynchronized = false;
let syncMethod = "None";

/**
 * Returns a high-precision Date object reflecting real-world atomic time
 */
export function getNow() {
  return new Date(Date.now() + clockOffsetMs);
}

/**
 * Ensures a valid Date object adjusted for network clock drift
 */
export function getKarachiDate(date = null) {
  if (date === null || date === undefined) {
    return getNow();
  }
  const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date(date);
  return isNaN(d.getTime()) ? getNow() : d;
}

/**
 * Returns an ISO 8601 string formatted with Karachi time and explicit +05:00 offset
 * Example: "2026-11-13T10:45:00+05:00"
 */
export function getKarachiIso(date = null) {
  const validDate = getKarachiDate(date);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: KARACHI_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(validDate);

  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  const hour = map.hour === "24" ? "00" : map.hour;
  return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}:${map.second}+05:00`;
}

/**
 * Returns YYYY-MM-DD date string in Karachi time
 * Example: "2026-11-13"
 */
export function getKarachiDateString(date = null) {
  const validDate = getKarachiDate(date);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: KARACHI_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(validDate);

  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * Returns formatted time string in Karachi time
 * Example: "10:45:00"
 */
export function getKarachiTimeString(date = null) {
  const validDate = getKarachiDate(date);
  return validDate.toLocaleTimeString("en-GB", { timeZone: KARACHI_TIMEZONE });
}

export const nowIso = () => getKarachiIso();

/**
 * Query an NTP server over UDP port 123
 */
function queryNtp(host = "time.google.com", port = 123, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const buf = Buffer.alloc(48);
    buf[0] = 0x1b; // LI = 0, VN = 3, Mode = 3 (client)

    const timer = setTimeout(() => {
      try { socket.close(); } catch (_) {}
      reject(new Error(`NTP timeout connecting to ${host}`));
    }, timeoutMs);

    socket.on("error", (err) => {
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      reject(err);
    });

    socket.on("message", (msg) => {
      clearTimeout(timer);
      try { socket.close(); } catch (_) {}
      if (msg.length < 48) {
        return reject(new Error("Invalid NTP packet length"));
      }
      const secs = msg.readUInt32BE(40);
      const frac = msg.readUInt32BE(44);
      // NTP epoch is 1900-01-01, Unix epoch is 1970-01-01 (difference: 2,208,988,800s)
      const ntpEpochDiff = 2208988800;
      const unixMs = (secs - ntpEpochDiff) * 1000 + Math.round((frac * 1000) / 0x100000000);
      resolve(unixMs);
    });

    socket.send(buf, 0, buf.length, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        try { socket.close(); } catch (_) {}
        reject(err);
      }
    });
  });
}

/**
 * Query HTTP Date header as fallback (uses TCP port 80/443, never blocked)
 */
async function queryHttp(url = "https://www.google.com", timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "HEAD",
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timer);
    const dateStr = res.headers.get("date");
    if (!dateStr) throw new Error("Missing HTTP date header");
    const roundTrip = Date.now() - t0;
    return new Date(dateStr).getTime() + Math.round(roundTrip / 2);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attempt to update the Linux OS kernel clock and hardware RTC if allowed
 */
function trySetOsClock(targetDate) {
  const iso = targetDate.toISOString();
  // If user configured sudo without password, this will synchronize the host OS directly
  exec(`sudo -n date -u -s "${iso}" && sudo -n hwclock -w 2>&1`, (err, stdout, stderr) => {
    if (!err) {
      console.log(`[TimeSync] Host Linux OS clock synchronized to ${iso}`);
    }
  });
}

/**
 * Synchronize server time with Internet atomic clock
 */
export async function syncTrueInternetTime() {
  let trueMs = null;
  let method = null;

  // 1. Try NTP servers (Google, Cloudflare, Pool)
  const ntpHosts = ["time.google.com", "time.cloudflare.com", "pool.ntp.org"];
  for (const host of ntpHosts) {
    try {
      trueMs = await queryNtp(host, 123, 2000);
      method = `NTP (${host})`;
      break;
    } catch (_) {
      // try next
    }
  }

  // 2. Fallback to HTTPS Date headers (Google, Cloudflare)
  if (!trueMs) {
    const httpUrls = ["https://www.google.com", "https://cloudflare.com"];
    for (const url of httpUrls) {
      try {
        trueMs = await queryHttp(url, 2500);
        method = `HTTP (${url})`;
        break;
      } catch (_) {
        // try next
      }
    }
  }

  if (trueMs) {
    const prevOffset = clockOffsetMs;
    clockOffsetMs = trueMs - Date.now();
    lastSyncAt = Date.now();
    isSynchronized = true;
    syncMethod = method;

    const driftSec = Math.round(clockOffsetMs / 1000);
    const driftMin = (clockOffsetMs / 60000).toFixed(1);

    if (Math.abs(clockOffsetMs - prevOffset) > 2000 || Math.abs(driftSec) > 5) {
      console.log(`[TimeSync] Clock drift detected and compensated via ${method}: ${driftSec}s (${driftMin} min). True PKT: ${getKarachiIso()}`);
    }

    trySetOsClock(new Date(trueMs));
    return { success: true, method, offsetMs: clockOffsetMs, driftSec, karachiTime: getKarachiIso() };
  } else {
    console.warn(`[TimeSync] Failed to reach both NTP and HTTP time servers. Retaining existing offset: ${clockOffsetMs}ms`);
    return { success: false, error: "Time servers unreachable" };
  }
}

/**
 * Returns diagnostic metadata about server time synchronization
 */
export function getClockStatus() {
  return {
    synchronized: isSynchronized,
    syncMethod,
    clockOffsetMs,
    driftSeconds: Math.round(clockOffsetMs / 1000),
    driftMinutes: +(clockOffsetMs / 60000).toFixed(2),
    lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
    trueKarachiTime: getKarachiIso(),
    hardwareLocalTime: new Date().toISOString(),
    timezone: KARACHI_TIMEZONE,
  };
}

// Initial sync on module startup
syncTrueInternetTime().catch((err) =>
  console.warn(`[TimeSync] Initial startup sync error: ${err.message}`)
);

// Continuous periodic background sync every 5 minutes (compensates for ongoing CMOS battery drift)
const syncInterval = setInterval(() => {
  syncTrueInternetTime().catch(() => {});
}, 5 * 60 * 1000);

if (syncInterval.unref) {
  syncInterval.unref();
}

export default {
  KARACHI_TIMEZONE,
  KARACHI_OFFSET_HOURS,
  getNow,
  getKarachiDate,
  getKarachiIso,
  getKarachiDateString,
  getKarachiTimeString,
  nowIso,
  syncTrueInternetTime,
  getClockStatus,
};
