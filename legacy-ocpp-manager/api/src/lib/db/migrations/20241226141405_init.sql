-- Enum Definitions
CREATE TYPE charger_status AS ENUM ('Accepted', 'Pending', 'Rejected');
CREATE TYPE connector_status AS ENUM (
    'Available', 'Preparing', 'Charging', 'SuspendedEVSE', 'SuspendedEV',
    'Finishing', 'Reserved', 'Unavailable', 'Faulted'
);
CREATE TYPE transaction_status AS ENUM ('Active', 'Completed', 'Interrupted', 'Failed');
CREATE TYPE payment_status AS ENUM ('Pending', 'Paid', 'Failed');

-- Table: charger
CREATE TABLE charger (
    id SERIAL PRIMARY KEY,
    serial_number TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    vendor TEXT NOT NULL DEFAULT '',
    firmware_version TEXT DEFAULT '',
    shortcode TEXT NOT NULL UNIQUE,
    friendly_name TEXT NOT NULL DEFAULT 'New Charger',
    status charger_status NOT NULL DEFAULT 'Pending',
    last_heartbeat TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: connector
CREATE TABLE connector (
    id SERIAL PRIMARY KEY,
    charger_id INTEGER NOT NULL REFERENCES charger(id) ON DELETE CASCADE,
    connector_id INTEGER NOT NULL,
    status connector_status NOT NULL DEFAULT 'Available',
    max_current INTEGER NOT NULL DEFAULT 0,
    error_code TEXT DEFAULT '',
    vendor_error_code TEXT DEFAULT '',
    info TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(charger_id, connector_id)
);

-- Table: rfid_tag
CREATE TABLE rfid_tag (
    id SERIAL PRIMARY KEY,
    rfid_tag TEXT NOT NULL UNIQUE,
    friendly_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: charge_authorization
CREATE TABLE charge_authorization (
    id SERIAL PRIMARY KEY,
    friendly_name TEXT NOT NULL DEFAULT '',
    charger_id INTEGER NOT NULL REFERENCES charger(id) ON DELETE CASCADE,
    rfid_tag_id INTEGER REFERENCES rfid_tag(id) ON DELETE CASCADE,
    expiry_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: transaction
CREATE TABLE transaction (
    id SERIAL PRIMARY KEY,
    connector_id INTEGER NOT NULL REFERENCES connector(id) ON DELETE CASCADE,
    charge_authorization_id INTEGER REFERENCES charge_authorization(id) ON DELETE SET NULL,
    meter_start INTEGER NOT NULL CHECK (meter_start >= 0),
    meter_stop INTEGER CHECK (meter_stop >= 0),
    start_time TIMESTAMPTZ NOT NULL,
    stop_time TIMESTAMPTZ,
    energy_delivered INTEGER GENERATED ALWAYS AS (meter_stop - meter_start) STORED,
    reason TEXT DEFAULT '',
    status transaction_status NOT NULL DEFAULT 'Active',
    payment_status payment_status NOT NULL DEFAULT 'Pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: telemetry
CREATE TABLE telemetry (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transaction(id) ON DELETE CASCADE,
    meter_value JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: setting
CREATE TABLE setting (
    id SERIAL PRIMARY KEY,
    system_maintenance BOOLEAN NOT NULL DEFAULT false,
    heartbeat_interval INTEGER NOT NULL DEFAULT 300
);

-- Insert initial settings row with default values
INSERT INTO setting (system_maintenance, heartbeat_interval)
VALUES (false, 300);
