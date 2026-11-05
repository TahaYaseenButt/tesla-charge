import { db } from "../database/db.js";
import { EventEmitter } from "events";
import { notifyChargerSubscribers } from "./notificationService.js";
import { getKarachiIso } from "../utils/time.js";

export const liveEvents = new EventEmitter();
liveEvents.setMaxListeners(200);

const nowIso = () => getKarachiIso();

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

// Track 3-minute power-loss watchdog timers per charger so brief internet drops (Scenario 1)
// are cancelled on reconnect, while permanent power outages (Scenario 2) auto-finalize sessions.
const offlinePowerLossTimers = new Map();

function clearPowerLossTimer(chargePointId) {
  const key = String(chargePointId || "charger1").toLowerCase();
  const existing = offlinePowerLossTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    offlinePowerLossTimers.delete(key);
  }
}

/**
 * Save charger heartbeat
 */
export async function saveChargerHeartbeat(chargePointId) {
  const cId = (chargePointId || "charger1").toLowerCase();
  clearPowerLossTimer(cId);
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
 * Save charger offline status.
 * Starts a 3-minute (180s) grace timer:
 * - Scenario 1 (Inverter/router internet drops briefly and reconnects): Timer is cancelled on first packet; session continues seamlessly.
 * - Scenario 2 (Electricity goes off during charging and does not return): After 3 minutes offline, any open 'Charging' session is finalized & saved.
 */
export async function saveChargerOffline(chargePointId) {
  const cId = (chargePointId || "charger1").toLowerCase();
  clearPowerLossTimer(cId);
  const now = nowIso();

  try {
    db.prepare(`
      UPDATE chargers SET status = 'Offline', updated_at = ?
      WHERE charge_point_id = ?
    `).run(now, cId);

    console.log(`[LocalSync] Charger marked Offline: [${cId}] (starting 3-min power-loss grace window)`);
    broadcastLive("charger_offline", { chargePointId: cId, status: "Offline" });

    const timer = setTimeout(async () => {
      offlinePowerLossTimers.delete(cId);
      try {
        const ch = db.prepare("SELECT status FROM chargers WHERE charge_point_id = ?").get(cId);
        if (ch && ch.status === "Online") return;

        const openTxs = db.prepare(`
          SELECT * FROM transactions
          WHERE charge_point_id = ? AND status = 'Charging'
        `).all(cId);

        for (const tx of openTxs) {
          const lastMeterWh =
            Number(tx.current_energy_wh) ||
            (Number(tx.meter_start || 0) + Number(tx.energy_delivered_wh || 0));
          const stopTs = tx.updated_at || nowIso();
          console.log(
            `[PowerLoss Watchdog] Charger [${cId}] Gun ${tx.connector_id} remained offline for 3 mins during Tx #${tx.transaction_id} -> Finalizing session at ${lastMeterWh} Wh`
          );
          await saveStopTransaction(tx.transaction_id, cId, lastMeterWh, stopTs, "PowerLoss");
        }
      } catch (wErr) {
        console.warn(`[PowerLoss Watchdog] Error checking ${cId}:`, wErr.message);
      }
    }, 180000);

    offlinePowerLossTimers.set(cId, timer);
  } catch (err) {
    console.error(`[LocalSync Error] saveChargerOffline:`, err.message);
  }
}

/**
 * Save connector status change
 */
export async function saveConnectorStatus(chargePointId, connectorId, status, errorCode, info) {
  const cId = (chargePointId || "charger1").toLowerCase();
  clearPowerLossTimer(cId);
  const connId = Number(connectorId || 1);
  const now = nowIso();

  try {
    db.prepare(`
      UPDATE chargers SET status = 'Online', last_heartbeat = ?, updated_at = ?
      WHERE charge_point_id = ?
    `).run(now, now, cId);

    // Scenario 2: If connector transitions to Available or Faulted while an unclosed Charging session exists
    // (e.g., electricity went off during charging and charger rebooted without sending StopTransaction),
    // automatically finalize and save the interrupted transaction!
    if (connId > 0 && (status === "Available" || status === "Faulted")) {
      const openTx = db.prepare(`
        SELECT * FROM transactions
        WHERE charge_point_id = ? AND connector_id = ? AND status = 'Charging'
        ORDER BY start_time DESC LIMIT 1
      `).get(cId, connId);

      if (openTx && openTx.transaction_id) {
        const lastMeterWh =
          Number(openTx.current_energy_wh) ||
          (Number(openTx.meter_start || 0) + Number(openTx.energy_delivered_wh || 0));
        const stopTs = openTx.updated_at || now;
        console.log(
          `[PowerLoss Recovery] Connector ${connId} on [${cId}] reported ${status} while Tx #${openTx.transaction_id} was still Charging -> Auto-completing session at ${lastMeterWh} Wh`
        );
        await saveStopTransaction(openTx.transaction_id, cId, lastMeterWh, stopTs, "PowerLoss");
      }
    }

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
  let now = nowIso();
  if (timestamp) {
    const tMs = new Date(timestamp).getTime();
    if (!isNaN(tMs) && Math.abs(Date.now() - tMs) < 24 * 3600 * 1000) {
      now = getKarachiIso(timestamp);
    }
  }

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
  clearPowerLossTimer(cId);
  const connId = Number(connectorId || 1);
  const now = nowIso();

  try {
    db.prepare(`
      UPDATE chargers SET status = 'Online', last_heartbeat = ?, updated_at = ?
      WHERE charge_point_id = ?
    `).run(now, now, cId);

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

      const voltage = Number(telemetry.voltage || telemetry.voltageL1 || telemetry.voltageL2 || telemetry.voltageL3 || 0);
      const isCharging = tx.status === 'Charging' || (telemetry.powerKw || 0) > 0 || (telemetry.currentL1 || 0) > 0;
      const shouldLockSocStart = (!tx.soc_start || tx.soc_start === 0) && isCharging && voltage >= 100 && typeof telemetry.soc === 'number' && telemetry.soc > 0;

      db.prepare(`
        UPDATE transactions SET
          energy_delivered_wh = ?,
          energy_delivered_kwh = ?,
          cost = ?,
          current_power_kw = ?,
          current_energy_wh = ?,
          soc_current = ?,
          soc_start = CASE 
            WHEN (soc_start IS NULL OR soc_start = 0) AND ? = 1 THEN ? 
            ELSE soc_start 
          END,
          updated_at = ?
        WHERE transaction_id = ?
      `).run(
        sessionEnergyWh,
        sessionEnergyKwh,
        liveCost,
        telemetry.powerKw || 0,
        telemetry.energyWh || 0,
        telemetry.soc || null,
        shouldLockSocStart ? 1 : 0,
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
  let now = nowIso();
  if (timestamp) {
    const tMs = new Date(timestamp).getTime();
    if (!isNaN(tMs) && Math.abs(Date.now() - tMs) < 24 * 3600 * 1000) {
      now = getKarachiIso(timestamp);
    }
  }

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
      const lastConn = db.prepare("SELECT soc FROM connectors WHERE charge_point_id = ? AND connector_id = ?").get(cId, tx?.connector_id || 1);
      const socStop = tx?.soc_current || lastConn?.soc || null;

      db.prepare(`
        UPDATE transactions SET
          status = 'Completed',
          stop_time = ?,
          meter_stop = ?,
          energy_delivered_wh = ?,
          energy_delivered_kwh = ?,
          cost = ?,
          reason = ?,
          soc_stop = COALESCE(?, soc_current),
          updated_at = ?
        WHERE transaction_id = ?
      `).run(now, Number(meterStop) || 0, finalWh, finalKwh, finalCost, reason || "Normal", socStop, now, txId);
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

  const activeTransactions = db.prepare(`
    SELECT * FROM transactions
    WHERE charge_point_id = ? AND status = 'Charging'
    ORDER BY start_time DESC
  `).all(cId);

  const activeTxMap = new Map();
  activeTransactions.forEach((tx) => {
    activeTxMap.set(Number(tx.connector_id), tx);
  });

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
      const rawTx = c.active_tx_id
        ? db.prepare("SELECT * FROM transactions WHERE transaction_id = ?").get(c.active_tx_id)
        : activeTxMap.get(Number(c.connector_id));

      const connTx = rawTx ? {
        transactionId: rawTx.transaction_id,
        id: rawTx.transaction_id,
        connectorId: rawTx.connector_id,
        status: rawTx.status,
        startTime: rawTx.start_time,
        meterStart: rawTx.meter_start,
        powerKw: rawTx.current_power_kw || c.power_kw || 0,
        currentPowerKw: rawTx.current_power_kw || c.power_kw || 0,
        energyDeliveredKwh: rawTx.energy_delivered_kwh || c.energy_kwh || 0,
        energyDeliveredWh: rawTx.energy_delivered_wh || c.energy_wh || 0,
        cost: rawTx.cost || 0,
        socStart: rawTx.soc_start,
        socCurrent: rawTx.soc_current || c.soc,
        socStop: rawTx.soc_stop,
        idTag: rawTx.id_tag,
        userEmail: rawTx.user_email,
      } : null;

      return {
        connectorId: c.connector_id,
        status: c.status,
        errorCode: c.error_code,
        info: c.info,
        activeTx: (isCharging || connTx) ? connTx : null,
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
          cost: connTx?.cost || 0,
        },
      };
    }),
    activeTransaction: activeTransactions[0] ? {
      transactionId: activeTransactions[0].transaction_id,
      id: activeTransactions[0].transaction_id,
      connectorId: activeTransactions[0].connector_id,
      status: activeTransactions[0].status,
      startTime: activeTransactions[0].start_time,
      meterStart: activeTransactions[0].meter_start,
      currentPowerKw: activeTransactions[0].current_power_kw,
      energyDeliveredKwh: activeTransactions[0].energy_delivered_kwh,
      energyDeliveredWh: activeTransactions[0].energy_delivered_wh,
      cost: activeTransactions[0].cost,
      socStart: activeTransactions[0].soc_start,
      socCurrent: activeTransactions[0].soc_current,
      socStop: activeTransactions[0].soc_stop,
      idTag: activeTransactions[0].id_tag,
      userEmail: activeTransactions[0].user_email,
    } : null,
    lastCompletedTx: lastCompletedTx ? {
      transactionId: lastCompletedTx.transaction_id,
      id: lastCompletedTx.transaction_id,
      connectorId: lastCompletedTx.connector_id,
      status: lastCompletedTx.status,
      startTime: lastCompletedTx.start_time,
      stopTime: lastCompletedTx.stop_time,
      createdAt: lastCompletedTx.created_at || lastCompletedTx.start_time,
      updatedAt: lastCompletedTx.updated_at || lastCompletedTx.stop_time,
      meterStart: lastCompletedTx.meter_start,
      meterStop: lastCompletedTx.meter_stop,
      energyDeliveredKwh: lastCompletedTx.energy_delivered_kwh,
      energyDeliveredWh: lastCompletedTx.energy_delivered_wh,
      cost: lastCompletedTx.cost,
      socStart: lastCompletedTx.soc_start,
      socStop: lastCompletedTx.soc_stop,
      socCurrent: lastCompletedTx.soc_current,
      socGained: (lastCompletedTx.soc_start && lastCompletedTx.soc_stop && lastCompletedTx.soc_stop >= lastCompletedTx.soc_start) ? Number((lastCompletedTx.soc_stop - lastCompletedTx.soc_start).toFixed(1)) : null,
      idTag: lastCompletedTx.id_tag,
      userEmail: lastCompletedTx.user_email,
      reason: lastCompletedTx.reason,
    } : null,
  };
}
