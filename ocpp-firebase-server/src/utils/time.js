/**
 * Time & Timezone Utilities
 * Enforces Asia/Karachi (Pakistan Standard Time, UTC+5) across all server operations.
 */

// Force process.env.TZ to Asia/Karachi
process.env.TZ = "Asia/Karachi";

export const KARACHI_TIMEZONE = "Asia/Karachi";
export const KARACHI_OFFSET_HOURS = 5;

/**
 * Ensures a valid Date object
 */
export function getKarachiDate(date = new Date()) {
  const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date(date);
  return isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Returns an ISO 8601 string formatted with Karachi time and explicit +05:00 offset
 * Example: "2026-11-03T10:18:00+05:00"
 */
export function getKarachiIso(date = new Date()) {
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
 * Example: "2026-11-03"
 */
export function getKarachiDateString(date = new Date()) {
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
 * Example: "10:18:00"
 */
export function getKarachiTimeString(date = new Date()) {
  const validDate = getKarachiDate(date);
  return validDate.toLocaleTimeString("en-GB", { timeZone: KARACHI_TIMEZONE });
}

export const nowIso = () => getKarachiIso();
export default {
  KARACHI_TIMEZONE,
  KARACHI_OFFSET_HOURS,
  getKarachiDate,
  getKarachiIso,
  getKarachiDateString,
  getKarachiTimeString,
  nowIso,
};
