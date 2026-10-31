import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure data folder exists
const dataDir = path.join(__dirname, "..", "..", "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "tcharge.db");
export const db = new Database(dbPath);

// Enable WAL mode for high-concurrency (reads never block writes)
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

// Initialize Schema
export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT DEFAULT 'user',
      rfid_card TEXT,
      station_id TEXT DEFAULT 'charger1',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chargers (
      charge_point_id TEXT PRIMARY KEY COLLATE NOCASE,
      model TEXT DEFAULT '240kW',
      display_model TEXT DEFAULT '240kW',
      vendor TEXT DEFAULT 'DC_TYPE',
      hardware_model TEXT DEFAULT '240kW',
      firmware_version TEXT DEFAULT '1.0.0',
      status TEXT DEFAULT 'Offline',
      tariff_rate REAL DEFAULT 125.0,
      currency TEXT DEFAULT 'PKR',
      location TEXT,
      last_boot_at TEXT,
      last_heartbeat TEXT,
      setup_completed_at TEXT,
      configured_by_user_id TEXT,
      configured_by_user_email TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connectors (
      charge_point_id TEXT NOT NULL COLLATE NOCASE,
      connector_id INTEGER NOT NULL,
      status TEXT DEFAULT 'Available',
      error_code TEXT DEFAULT 'NoError',
      info TEXT DEFAULT '',
      power_kw REAL DEFAULT 0.0,
      voltage REAL DEFAULT 0.0,
      voltage_l1 REAL DEFAULT 0.0,
      voltage_l2 REAL DEFAULT 0.0,
      voltage_l3 REAL DEFAULT 0.0,
      current_l1 REAL DEFAULT 0.0,
      current_l2 REAL DEFAULT 0.0,
      current_l3 REAL DEFAULT 0.0,
      energy_kwh REAL DEFAULT 0.0,
      energy_wh REAL DEFAULT 0.0,
      soc REAL DEFAULT 0.0,
      active_tx_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (charge_point_id, connector_id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      transaction_id TEXT PRIMARY KEY,
      charge_point_id TEXT NOT NULL COLLATE NOCASE,
      connector_id INTEGER NOT NULL,
      user_id TEXT,
      user_email TEXT,
      id_tag TEXT,
      status TEXT DEFAULT 'Charging',
      start_time TEXT NOT NULL,
      stop_time TEXT,
      meter_start REAL DEFAULT 0.0,
      meter_stop REAL DEFAULT 0.0,
      energy_delivered_kwh REAL DEFAULT 0.0,
      energy_delivered_wh REAL DEFAULT 0.0,
      tariff_rate REAL DEFAULT 125.0,
      cost REAL DEFAULT 0.0,
      payment_status TEXT DEFAULT 'Pending',
      reason TEXT,
      soc_start REAL,
      soc_stop REAL,
      soc_current REAL,
      current_power_kw REAL DEFAULT 0.0,
      current_energy_wh REAL DEFAULT 0.0,
      target_kwh REAL,
      target_price REAL,
      target_minutes REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rfid_tags (
      tag_id TEXT PRIMARY KEY COLLATE NOCASE,
      charge_point_id TEXT NOT NULL COLLATE NOCASE,
      user_id TEXT,
      user_email TEXT,
      status TEXT DEFAULT 'Accepted',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      charge_point_id TEXT NOT NULL COLLATE NOCASE,
      action TEXT NOT NULL,
      connector_id INTEGER DEFAULT 1,
      transaction_id TEXT,
      user_id TEXT,
      user_email TEXT,
      status TEXT DEFAULT 'pending',
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_tokens (
      token TEXT PRIMARY KEY,
      charge_point_id TEXT NOT NULL COLLATE NOCASE,
      user_id TEXT,
      platform TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_charger ON transactions(charge_point_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_rfid_tags_charger ON rfid_tags(charge_point_id);
    CREATE INDEX IF NOT EXISTS idx_push_tokens_charger ON push_tokens(charge_point_id);
  `);

  // Migration: Ensure station_id column exists on users table
  try {
    db.prepare("ALTER TABLE users ADD COLUMN station_id TEXT DEFAULT 'charger1'").run();
  } catch (_e) {
    // Column already exists
  }

  const now = new Date().toISOString();

  // Ensure 'charger1' exists with owner telsa@teksa.cok and tariff 125
  db.prepare(`
    INSERT INTO chargers (
      charge_point_id, model, display_model, vendor, hardware_model, firmware_version,
      status, tariff_rate, currency, configured_by_user_id, configured_by_user_email, updated_at
    ) VALUES (
      'charger1', '240kW', '240kW', 'DC_TYPE', '240kW', '1.0.0',
      'Offline', 125.0, 'PKR', 'XIiBSAyJdugfkuAH9ceTGhgCBSh2', 'telsa@teksa.cok', ?
    )
    ON CONFLICT(charge_point_id) DO UPDATE SET
      tariff_rate = excluded.tariff_rate,
      configured_by_user_id = COALESCE(chargers.configured_by_user_id, excluded.configured_by_user_id),
      configured_by_user_email = COALESCE(chargers.configured_by_user_email, excluded.configured_by_user_email)
  `).run(now);

  // Ensure 'aziz light and solar' exists with owner hafeezabro22@gmail.com and tariff 90
  db.prepare(`
    INSERT INTO chargers (
      charge_point_id, model, display_model, vendor, hardware_model, firmware_version,
      status, tariff_rate, currency, configured_by_user_id, configured_by_user_email, updated_at
    ) VALUES (
      'aziz light and solar', '60kW', '60kW', 'DC_TYPE', '60kW', '1.0.0',
      'Offline', 90.0, 'PKR', 'xO36Rwrs3ZYkiK4N0jm1MYe21hv2', 'hafeezabro22@gmail.com', ?
    )
    ON CONFLICT(charge_point_id) DO UPDATE SET
      tariff_rate = excluded.tariff_rate,
      configured_by_user_id = COALESCE(chargers.configured_by_user_id, excluded.configured_by_user_id),
      configured_by_user_email = COALESCE(chargers.configured_by_user_email, excluded.configured_by_user_email)
  `).run(now);

  // Seed default connectors for both stations
  for (const cId of [0, 1, 2]) {
    db.prepare(`
      INSERT OR IGNORE INTO connectors (
        charge_point_id, connector_id, status, error_code, info, updated_at
      ) VALUES ('charger1', ?, 'Available', 'NoError', '', ?)
    `).run(cId, now);

    db.prepare(`
      INSERT OR IGNORE INTO connectors (
        charge_point_id, connector_id, status, error_code, info, updated_at
      ) VALUES ('aziz light and solar', ?, 'Available', 'NoError', '', ?)
    `).run(cId, now);
  }

  console.log("[Database] Initialized and verified tenant-isolated chargers: charger1 (125 PKR) and aziz light and solar (90 PKR)");
}
