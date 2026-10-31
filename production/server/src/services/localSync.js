import { db } from "../database/db.js";
import { EventEmitter } from "events";
import { notifyChargerSubscribers } from "./notificationService.js";

export const liveEvents = new EventEmitter();
liveEvents.setMaxListeners(200);

const nowIso = () => new Date().toISOString();

/**
 * Broadcast an event to all connected SSE clients (mobile apps & web dashboard)
 */
export function broadcastLive(type, data) {
  liveEvents.emit("update", { type, data, timestamp: nowIso() });
}

/**
 * Save charger boot notification to local SQLite
 */
export async function saveChargerBoot(chargePointId, data) {
  const cId = (chargePointId || "charger1").toLowerCase();
  const now = nowIso();

  try {
    const existing = db.prepare("SELECT model, display_model FROM chargers WHERE charge_point_id = ?").get(cId);
    let model = existing?.model || "240kW";
    let displayModel = existing?.display_model || "240kW";

    const stmt = db.prepare(`
      INSERT INTO chargers (
        charge_point_id, vendor, hardware_model, firmware_version, model, display_model,
        status, last_boot_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'Online', ?, ?)
      ON CONFLICT(charge_point_id) DO UPDATE SET
        vendor = excluded.vendor,
        hardware_model = excluded.hardware_model,
        firmware_version = excluded.firmware_version,
        status = 'Online',
        last_boot_at = excluded.last_boot_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      cId,
      data.chargePointVendor || "Unknown",
      data.chargePointModel || "240kW",
      data.firmwareVersion || "1.0.0",
      model,
      displayModel,
      now,
      now
    );

    console.log(`[LocalSync] Boot info saved for [${cId}] [Model: ${model}]`);
    broadcastLive("charger_boot", { chargePointId: cId, status: "Online", model, lastBootAt: now });
  } catch (err) {
    console.error(`[LocalSync Error] saveChargerBoot:`, err.message);
  }
}

/**
 * Save charger heartbeat
 */
export async function saveChargerHeartbeat(chargePointId) {
  const cId = (chargePointId || "charger1").toLowerCase();
  const now = nowIso();

  try {
    db.prepare(`
      UPDATE chargers SET status = 'Online', last_heartbeat = ?, updated_at = ?
      WHERE charge_point_id = ?
    `).run(now, now, cId);

    broadcastLive("heartbeat", { chargePointId: cId, lastHeartbeat: now });
  } catch (err) {
    console.error(`[LocalSync Error] saveChargerHeartbeat:`, err.message);
  }
}

/**
 * Save charger offline status
 */
export async function saveChargerOffline(chargePointId) {
  const cId = (chargePointId || "charger1").toLowerCase();
  const now = nowIso();

  try {
    db.prepare(`
      UPDATE chargers SET status = 'Offline', updated_at = ?
      WHERE charge_point_id = ?
    `).run(now, cId);

    console.log(`[LocalSync] Charger marked Offline: [${cId}]`);
    broadcastLive("charger_offline", { chargePointId: cId, status: "Offline" });
  } catch (err) {
    console.error(`[LocalSync Error] saveChargerOffline:`, err.message);
  }
}

/**
 * Save connector status change
 */
export async function saveConnectorStatus(chargePointId, connectorId, status, errorCode, info) {
  const cId = (chargePointId || "charger1").toLowerCase();
  const connId = Number(connectorId || 1);
  const now = nowIso();

  try {
    db.prepare(`
      INSERT INTO connectors (
        charge_point_id, connector_id, status, error_code, info, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(charge_point_id, connector_id) DO UPDATE SET
        status = excluded.status,
        error_code = excluded.error_code,
        info = excluded.info,
        updated_at = excluded.updated_at
    `).run(cId, connId, status, errorCode || "NoError", info || "", now);

    console.log(`[LocalSync] Connector [${cId}] Gun ${connId}: ${status}`);
    broadcastLive("connector_status", { chargePointId: cId, connectorId: connId, status, errorCode });

    if (status === "Preparing") {
      const gunName = connId === 2 ? "Gun B" : "Gun A";
      notifyChargerSubscribers(cId, {
        title: "🔌 Vehicle Connected",
        body: `A vehicle was plugged into ${gunName} at ${cId.toUpperCase()}.`,
        data: { chargePointId: cId, connectorId: connId, status: "Preparing" },
      });
    }
  } catch (err) {
    console.error(`[LocalSync Error] saveConnectorStatus:`, err.message);
  }
}

/**
 * Save StartTransaction
 */
export async function saveStartTransaction(transactionId, chargePointId, connectorId, idTag, meterStart, timestamp) {
  const cId = (chargePointId || "charger1").toLowerCase();
  const connId = Number(connectorId || 1);
  const txId = String(transactionId);
  const now = timestamp || nowIso();

  try {
    // Get tariff rate from charger config
    const charger = db.prepare("SELECT tariff_rate FROM chargers WHERE charge_point_id = ?").get(cId);
    const tariffRate = charger?.tariff_rate || 125.0;

    // Look up user linked to this idTag or default
    const rfidUser = db.prepare("SELECT user_id, user_email FROM rfid_tags WHERE tag_id = ?").get(idTag);
    const userId = rfidUser?.user_id || "AppUser";
    const userEmail = rfidUser?.user_email || idTag;

    db.prepare(`
      INSERT INTO transactions (
        transaction_id, charge_point_id, connector_id, user_id, user_email,
        id_tag, status, start_time, meter_start, tariff_rate, cost, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'Charging', ?, ?, ?, 0.0, ?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET
        status = 'Charging',
        start_time = excluded.start_time,
        meter_start = excluded.meter_start,
        updated_at = excluded.updated_at
    `).run(txId, cId, connId, userId, userEmail, idTag, now, Number(meterStart) || 0, tariffRate, now, now);

    // Link active transaction to connector
    db.prepare(`
      UPDATE connectors SET
        status = 'Charging',
        active_tx_id = ?,
        updated_at = ?
      WHERE charge_point_id = ? AND connector_id = ?
    `).run(txId, now, cId, connId);

    console.log(`[LocalSync] StartTransaction #${txId} on [${cId}] Gun ${connId}`);
    broadcastLive("transaction_start", {
      transactionId: txId,
      chargePointId: cId,
      connectorId: connId,
      idTag,
      meterStart,
      startTime: now
    });

    const gunName = connId === 2 ? "Gun B" : "Gun A";
    notifyChargerSubscribers(cId, {
      title: "⚡ Charging Started",
      body: `Charging session #${txId} started on ${gunName}.`,
      data: { chargePointId: cId, connectorId: connId, transactionId: txId, status: "Charging" },
    });
  } catch (err) {
    console.error(`[LocalSync Error] saveStartTransaction:`, err.message);
  }
}

/**
 * Save MeterValues & recalculate delivered energy and cost
 */
export async function saveMeterValues(chargePointId, connectorId, transactionId, telemetry) {
  const cId = (chargePointId || "charger1").toLowerCase();
  const connId = Number(connectorId || 1);
  const now = nowIso();

  try {
    // Resolve active transaction
    let tx = null;
    if (transactionId) {
      tx = db.prepare("SELECT * FROM transactions WHERE transaction_id = ?").get(String(transactionId));
    }
    if (!tx) {
      tx = db.prepare(`
        SELECT * FROM transactions
        WHERE charge_point_id = ? AND connector_id = ? AND status = 'Charging'
        ORDER BY start_time DESC LIMIT 1
      `).get(cId, connId);
    }

    let sessionEnergyWh = 0;
    let sessionEnergyKwh = 0;
    let liveCost = 0;
    const tariff = tx?.tariff_rate || 125.0;

    if (tx && tx.status === "Charging") {
      const mStart = Number(tx.meter_start) || 0;
      if (telemetry.energyWh > 0 && mStart > 0 && telemetry.energyWh >= mStart) {
        sessionEnergyWh = telemetry.energyWh - mStart;
        sessionEnergyKwh = Number((sessionEnergyWh / 1000).toFixed(3));
      } else if (telemetry.energyKwh > 0 && mStart > 0 && (telemetry.energyKwh * 1000) >= mStart) {
        sessionEnergyWh = Math.round(telemetry.energyKwh * 1000) - mStart;
        sessionEnergyKwh = Number((sessionEnergyWh / 1000).toFixed(3));
      }

      liveCost = Math.round(sessionEnergyKwh * tariff);

      db.prepare(`
        UPDATE transactions SET
          energy_delivered_wh = ?,
          energy_delivered_kwh = ?,
          cost = ?,
          current_power_kw = ?,
          current_energy_wh = ?,
          soc_current = ?,
          updated_at = ?
        WHERE transaction_id = ?
      `).run(
        sessionEnergyWh,
        sessionEnergyKwh,
        liveCost,
        telemetry.powerKw || 0,
        telemetry.energyWh || 0,
        telemetry.soc || null,
        now,
        tx.transaction_id
      );
    }

    // Update connector live telemetry
    db.prepare(`
      UPDATE connectors SET
        power_kw = ?,
        voltage = ?,
        voltage_l1 = ?,
        voltage_l2 = ?,
        voltage_l3 = ?,
        current_l1 = ?,
        current_l2 = ?,
        current_l3 = ?,
        energy_kwh = ?,
        energy_wh = ?,
        soc = ?,
        updated_at = ?
      WHERE charge_point_id = ? AND connector_id = ?
    `).run(
      telemetry.powerKw || 0,
      telemetry.voltage || 0,
      telemetry.voltageL1 || telemetry.voltage || 0,
      telemetry.voltageL2 || 0,
      telemetry.voltageL3 || 0,
      telemetry.currentL1 || 0,
      telemetry.currentL2 || 0,
      telemetry.currentL3 || 0,
      sessionEnergyKwh > 0 ? sessionEnergyKwh : (telemetry.energyKwh || 0),
      telemetry.energyWh || 0,
      telemetry.soc || 0,
      now,
      cId,
      connId
    );

    const payload = {
      chargePointId: cId,
      connectorId: connId,
      transactionId: tx?.transaction_id || null,
      telemetry: {
        powerKw: telemetry.powerKw || 0,
        voltage: telemetry.voltage || 0,
        currentL1: telemetry.currentL1 || 0,
        energyKwh: sessionEnergyKwh > 0 ? sessionEnergyKwh : (telemetry.energyKwh || 0),
        energyWh: telemetry.energyWh || 0,
        soc: telemetry.soc || 0,
        cost: liveCost,
      }
    };

    broadcastLive("meter_values", payload);

    return {
      resolvedTxId: tx?.transaction_id,
      sessionEnergyKwh,
      sessionEnergyWh,
      liveCost,
      powerKw: telemetry.powerKw || 0,
      soc: telemetry.soc,
      activeTx: tx,
      effectiveTariff: tariff,
    };
  } catch (err) {
    console.error(`[LocalSync Error] saveMeterValues:`, err.message);
    return null;
  }
}

/**
 * Save StopTransaction
 */
export async function saveStopTransaction(transactionId, chargePointId, meterStop, timestamp, reason, explicitTariff) {
  const cId = (chargePointId || "charger1").toLowerCase();
  const txId = String(transactionId);
  const now = timestamp || nowIso();

  try {
    const tx = db.prepare("SELECT * FROM transactions WHERE transaction_id = ?").get(txId);
    let finalKwh = 0;
    let finalWh = 0;
    let finalCost = 0;
    const tariff = explicitTariff || tx?.tariff_rate || 125.0;

    if (tx) {
      const mStart = Number(tx.meter_start) || 0;
      const mStop = Number(meterStop) || 0;
      if (mStop > mStart) {
        finalWh = mStop - mStart;
        finalKwh = Number((finalWh / 1000).toFixed(3));
      } else {
        finalWh = tx.energy_delivered_wh || 0;
        finalKwh = tx.energy_delivered_kwh || 0;
      }
      finalCost = Math.round(finalKwh * tariff);

      db.prepare(`
        UPDATE transactions SET
          status = 'Completed',
          stop_time = ?,
          meter_stop = ?,
          energy_delivered_wh = ?,
          energy_delivered_kwh = ?,
          cost = ?,
          reason = ?,
          updated_at = ?
        WHERE transaction_id = ?
      `).run(now, Number(meterStop) || 0, finalWh, finalKwh, finalCost, reason || "Normal", now, txId);
    }

    // Clear activeTx from connector and set back to Available
    const connId = tx?.connector_id || 1;
    db.prepare(`
      UPDATE connectors SET
        status = 'Available',
        active_tx_id = NULL,
        power_kw = 0.0,
        current_l1 = 0.0,
        voltage = 0.0,
        updated_at = ?
      WHERE charge_point_id = ? AND connector_id = ?
    `).run(now, cId, connId);

    console.log(`[LocalSync] StopTransaction #${txId} finished on [${cId}] Gun ${connId}: ${finalKwh} kWh, PKR ${finalCost}`);

    broadcastLive("transaction_stop", {
      transactionId: txId,
      chargePointId: cId,
      connectorId: connId,
      energyDeliveredKwh: finalKwh,
      cost: finalCost,
      reason
    });

    const gunName = connId === 2 ? "Gun B" : "Gun A";
    notifyChargerSubscribers(cId, {
      title: "✅ Charging Completed",
      body: `Session #${txId} finished on ${gunName}: ${finalKwh} kWh delivered (PKR ${finalCost}).`,
      data: { chargePointId: cId, connectorId: connId, transactionId: txId, status: "Completed", finalKwh, finalCost },
    });

    return { success: true, connectorId: connId, finalKwh, finalCost };
  } catch (err) {
    console.error(`[LocalSync Error] saveStopTransaction:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Verify RFID card tag
 */
export async function verifyRfidTag(chargePointId, idTag) {
  const tag = (idTag || "").trim();
  try {
    const row = db.prepare("SELECT * FROM rfid_tags WHERE tag_id = ? COLLATE NOCASE").get(tag);
    if (row) {
      return { status: row.status || "Accepted", userEmail: row.user_email };
    }
    // If not explicitly configured, default accept for ease of hardware pairing
    return { status: "Accepted" };
  } catch (err) {
    return { status: "Accepted" };
  }
}

/**
 * Retrieve full live state for a charger (for API and Web Dashboard)
 */
export function getLocalChargerLive(chargePointId) {
  const cId = (chargePointId || "charger1").toLowerCase();
  const charger = db.prepare("SELECT * FROM chargers WHERE charge_point_id = ?").get(cId) || {
    charge_point_id: cId,
    model: "240kW",
    display_model: "240kW",
    vendor: "DC_TYPE",
    status: "Offline",
    tariff_rate: 125.0,
    currency: "PKR",
  };

  const connectors = db.prepare("SELECT * FROM connectors WHERE charge_point_id = ? ORDER BY connector_id ASC").all(cId);

  const activeTx = db.prepare(`
    SELECT * FROM transactions
    WHERE charge_point_id = ? AND status = 'Charging'
    ORDER BY start_time DESC LIMIT 1
  `).get(cId);

  const lastCompletedTx = db.prepare(`
    SELECT * FROM transactions
    WHERE charge_point_id = ? AND status = 'Completed'
    ORDER BY stop_time DESC LIMIT 1
  `).get(cId);

  return {
    charger: {
      chargePointId: charger.charge_point_id,
      model: charger.model,
      displayModel: charger.display_model,
      vendor: charger.vendor,
      hardwareModel: charger.hardware_model,
      firmwareVersion: charger.firmware_version,
      status: charger.status,
      tariffRate: charger.tariff_rate,
      currency: charger.currency,
      location: charger.location,
      lastBootAt: charger.last_boot_at,
      lastHeartbeat: charger.last_heartbeat,
    },
    connectors: connectors.map((c) => {
      const isCharging = c.status === "Charging";
      const connTx = activeTx && activeTx.connector_id === c.connector_id ? {
        transactionId: activeTx.transaction_id,
        id: activeTx.transaction_id,
        connectorId: activeTx.connector_id,
        status: activeTx.status,
        startTime: activeTx.start_time,
        meterStart: activeTx.meter_start,
        powerKw: activeTx.power_kw,
        energyDeliveredKwh: activeTx.energy_kwh,
        cost: activeTx.cost,
        soc: activeTx.soc,
        idTag: activeTx.id_tag,
      } : null;

      return {
        connectorId: c.connector_id,
        status: c.status,
        errorCode: c.error_code,
        info: c.info,
        activeTx: isCharging ? connTx : null,
        telemetry: {
          powerKw: c.power_kw,
          voltage: c.voltage,
          voltageL1: c.voltage_l1,
          voltageL2: c.voltage_l2,
          voltageL3: c.voltage_l3,
          currentL1: c.current_l1,
          energyKwh: c.energy_kwh,
          energyWh: c.energy_wh,
          soc: c.soc,
          cost: activeTx && activeTx.connector_id === c.connector_id ? activeTx.cost : 0,
        },
      };
    }),
    activeTransaction: activeTx || null,
    lastCompletedTx: lastCompletedTx || null,
  };
}
