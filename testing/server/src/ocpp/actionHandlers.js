import {
  saveChargerBoot,
  saveChargerHeartbeat,
  saveConnectorStatus,
  saveMeterValues,
  saveStartTransaction,
  saveStopTransaction,
  verifyRfidTag,
  broadcastLive,
} from "../services/localSync.js";
import { db } from "../database/db.js";

// Helper to generate transaction IDs
let nextTxId = Date.now() % 1000000;

/**
 * Evaluates session limits with predictive latency compensation.
 */
async function enforceAutoStopIfTargetReached(chargePointId, connectorId, meterResult) {
  try {
    if (!meterResult || !meterResult.resolvedTxId) return;
    const { resolvedTxId, sessionEnergyKwh, liveCost, powerKw, soc, activeTx, effectiveTariff } = meterResult;
    if (!activeTx) return;

    if (activeTx.status === "Finishing" || activeTx.status === "Completed") {
      return;
    }

    const targetPrice = activeTx.target_price ? Number(activeTx.target_price) : null;
    const targetKwh = activeTx.target_kwh ? Number(activeTx.target_kwh) : null;
    const targetMinutes = activeTx.target_minutes ? Number(activeTx.target_minutes) : null;

    if (!targetPrice && !targetKwh && !targetMinutes) {
      return;
    }

    const kw = Number(powerKw) || 0;
    const tariff = Number(effectiveTariff) || 125;

    const leadSeconds = 5;
    const projectedKwhLead = kw > 0 ? (kw * (leadSeconds / 3600)) : 0;
    const projectedCostLead = projectedKwhLead * tariff;

    let shouldStop = false;
    let stopReason = "";

    // 1. Budget / Price Limit check (PKR)
    if (targetPrice && targetPrice > 0) {
      if (liveCost >= targetPrice) {
        shouldStop = true;
        stopReason = `Budget limit reached: PKR ${liveCost} >= target PKR ${targetPrice}`;
      } else if (kw > 0 && (liveCost + projectedCostLead) >= targetPrice) {
        shouldStop = true;
        stopReason = `Predictive budget limit reached: PKR ${liveCost} (+PKR ${projectedCostLead.toFixed(1)} projected @ ${kw.toFixed(1)}kW) >= target PKR ${targetPrice}`;
      }
    }

    // 2. Energy Limit check (kWh)
    if (!shouldStop && targetKwh && targetKwh > 0) {
      if (sessionEnergyKwh >= targetKwh) {
        shouldStop = true;
        stopReason = `Energy limit reached: ${sessionEnergyKwh.toFixed(2)} kWh >= target ${targetKwh.toFixed(2)} kWh`;
      } else if (kw > 0 && (sessionEnergyKwh + projectedKwhLead) >= targetKwh) {
        shouldStop = true;
        stopReason = `Predictive energy limit reached: ${sessionEnergyKwh.toFixed(2)} kWh (+${projectedKwhLead.toFixed(3)} projected @ ${kw.toFixed(1)}kW) >= target ${targetKwh.toFixed(2)} kWh`;
      }
    }

    // 3. Time Limit check (minutes)
    if (!shouldStop && targetMinutes && targetMinutes > 0 && activeTx.start_time) {
      const elapsedMinutes = (Date.now() - new Date(activeTx.start_time).getTime()) / 60000;
      if (elapsedMinutes >= targetMinutes) {
        shouldStop = true;
        stopReason = `Time duration limit reached: ${Math.round(elapsedMinutes)} mins >= target ${targetMinutes} mins`;
      }
    }

    if (shouldStop) {
      console.log(`[Safety Interlock] >>> AUTO-STOPPING: ${stopReason} on [${chargePointId}] Gun ${connectorId} (Tx #${resolvedTxId}) <<<`);

      // Mark Finishing in local DB
      db.prepare("UPDATE connectors SET status = 'Finishing', info = ? WHERE charge_point_id = ? AND connector_id = ?")
        .run(`Stopping: ${stopReason}`, chargePointId.toLowerCase(), connectorId);

      broadcastLive("connector_status", {
        chargePointId: chargePointId.toLowerCase(),
        connectorId,
        status: "Finishing",
        info: `Stopping: ${stopReason}`
      });

      // Dispatch RemoteStopTransaction to hardware
      const { ocppServer } = await import("./OCPPServer.js");
      await ocppServer.remoteStopTransaction(chargePointId, resolvedTxId);
    }
  } catch (err) {
    console.warn(`[Safety Interlock] Target check notice:`, err.message);
  }
}

export const actionHandlers = {
  /**
   * Charger powers on or connects
   */
  async BootNotification(chargePointId, payload) {
    console.log(`[OCPP] BootNotification from ${chargePointId}:`, payload);
    saveChargerBoot(chargePointId, payload).catch((err) =>
      console.warn(`[LocalSync] saveChargerBoot warning: ${err.message}`)
    );

    return {
      status: "Accepted",
      currentTime: new Date().toISOString(),
      interval: parseInt(process.env.HEARTBEAT_INTERVAL || "30", 10),
    };
  },

  /**
   * Charger periodic heartbeat
   */
  async Heartbeat(chargePointId, _payload) {
    saveChargerHeartbeat(chargePointId).catch((err) =>
      console.warn(`[LocalSync] saveChargerHeartbeat warning: ${err.message}`)
    );
    return {
      currentTime: new Date().toISOString(),
    };
  },

  /**
   * Connector status change (Available, Preparing, Charging, Faulted...)
   */
  async StatusNotification(chargePointId, payload) {
    const { connectorId, status, errorCode, info } = payload;
    console.log(`[OCPP] StatusNotification from ${chargePointId} [Connector ${connectorId}]: ${status}`);
    saveConnectorStatus(chargePointId, connectorId, status, errorCode, info).catch((err) =>
      console.warn(`[LocalSync] saveConnectorStatus warning: ${err.message}`)
    );
    return {};
  },

  /**
   * RFID badge / App card authorization
   */
  async Authorize(chargePointId, payload) {
    const { idTag } = payload;
    console.log(`[OCPP] Authorize request on ${chargePointId} for tag: ${idTag}`);
    const authResult = await verifyRfidTag(chargePointId, idTag);

    let parentId = idTag;
    let activeTxToStop = null;

    try {
      // Find active charging session for this charger
      activeTxToStop = db.prepare(`
        SELECT * FROM transactions
        WHERE charge_point_id = ? AND status = 'Charging'
        ORDER BY start_time DESC LIMIT 1
      `).get(chargePointId.toLowerCase());

      if (activeTxToStop) {
        parentId = activeTxToStop.id_tag || idTag;
      }
    } catch (_e) {}

    // If an authorized RFID tag was tapped while charging, trigger remote stop as fail-safe
    if (authResult.status === "Accepted" && activeTxToStop && activeTxToStop.transaction_id) {
      console.log(`[OCPP] Authorized RFID tag ${idTag} tapped while Tx #${activeTxToStop.transaction_id} is charging -> Dispatching remote stop`);
      const targetConn = Number(activeTxToStop.connector_id || 1);
      setTimeout(async () => {
        try {
          const { ocppServer } = await import("./OCPPServer.js");
          await ocppServer.remoteStopTransaction(chargePointId, Number(activeTxToStop.transaction_id));
          setTimeout(async () => {
            try {
              await ocppServer.unlockConnector(chargePointId, targetConn);
              console.log(`[OCPP] Cable auto-unlocked for connector ${targetConn} on RFID stop`);
            } catch (_uErr) {}
          }, 1200);
        } catch (stopErr) {
          console.warn(`[OCPP] RFID-triggered remote stop notice:`, stopErr.message);
        }
      }, 200);
    }

    return {
      idTagInfo: {
        status: authResult.status || "Accepted",
        parentIdTag: parentId,
        expiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      },
    };
  },

  /**
   * Start Transaction
   */
  async StartTransaction(chargePointId, payload) {
    const { connectorId, idTag, meterStart, timestamp } = payload;
    const authResult = await verifyRfidTag(chargePointId, idTag);

    if (authResult.status === "Blocked") {
      console.warn(`[OCPP] StartTransaction rejected: tag ${idTag} is Blocked`);
      return {
        transactionId: 0,
        idTagInfo: { status: "Blocked" },
      };
    }

    // Deduplication check
    try {
      const active = db.prepare(`
        SELECT * FROM transactions
        WHERE charge_point_id = ? AND connector_id = ? AND status = 'Charging'
        ORDER BY start_time DESC LIMIT 1
      `).get(chargePointId.toLowerCase(), connectorId);

      if (active) {
        const isMeterMatch = Math.abs(Number(active.meter_start || 0) - Number(meterStart || 0)) < 50;
        const isTimeMatch = active.start_time === timestamp;
        if (isMeterMatch || isTimeMatch) {
          console.log(`[OCPP] Deduplicated StartTransaction retry for ${chargePointId} [Connector ${connectorId}] -> Reusing TxId #${active.transaction_id}`);
          return {
            transactionId: Number(active.transaction_id),
            idTagInfo: { status: "Accepted" },
          };
        }
      }
    } catch (_dedupErr) {}

    const txId = ++nextTxId;

    console.log(
      `[OCPP] StartTransaction on ${chargePointId} [Connector ${connectorId}], TxId: ${txId}, MeterStart: ${meterStart}, Tag: ${idTag}`
    );

    await saveStartTransaction(txId, chargePointId, connectorId, idTag, meterStart, timestamp);

    return {
      transactionId: txId,
      idTagInfo: {
        status: "Accepted",
        expiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      },
    };
  },

  /**
   * Stop Transaction
   */
  async StopTransaction(chargePointId, payload) {
    const { transactionId, meterStop, timestamp, reason } = payload;

    console.log(
      `[OCPP] StopTransaction on ${chargePointId}, TxId: ${transactionId}, MeterStop: ${meterStop}, Reason: ${reason}`
    );

    const result = await saveStopTransaction(
      transactionId,
      chargePointId,
      meterStop,
      timestamp,
      reason,
      null
    );

    // Automatically unlock cable immediately on stop
    const targetConnId = result?.connectorId || 1;
    setTimeout(async () => {
      try {
        const { ocppServer } = await import("./OCPPServer.js");
        await ocppServer.unlockConnector(chargePointId, targetConnId);
        console.log(`[OCPP] Auto-unlocked cable for [${chargePointId}] on connector ${targetConnId} after stop`);
      } catch (_e) {}
    }, 1000);

    return {
      idTagInfo: {
        status: "Accepted",
      },
    };
  },

  /**
   * Periodic live meter values during charging
   */
  async MeterValues(chargePointId, payload) {
    const { connectorId, transactionId, meterValue } = payload;
    const telemetry = {
      powerKw: 0,
      energyKwh: 0,
      energyWh: 0,
      voltage: 0,
      voltageL1: 0,
      voltageL2: 0,
      voltageL3: 0,
      currentL1: 0,
      currentL2: 0,
      currentL3: 0,
      temperatureC: 0,
      soc: 0,
    };

    if (meterValue && meterValue.length > 0) {
      for (const entry of meterValue) {
        if (!entry.sampledValue) continue;
        for (const sample of entry.sampledValue) {
          const val = parseFloat(sample.value) || 0;
          const measurandRaw = sample.measurand || "Energy.Active.Import.Register";
          const mLower = measurandRaw.toLowerCase();
          const unit = (sample.unit || "").toUpperCase();
          const phase = sample.phase;

          if (mLower === "power.active.import" || mLower === "power") {
            telemetry.powerKw = unit === "KW" ? val : Number((val / 1000).toFixed(2));
          } else if (mLower.includes("energy.active.import") || mLower === "energy") {
            if (unit === "KWH") {
              telemetry.energyKwh = val;
              telemetry.energyWh = Math.round(val * 1000);
            } else {
              telemetry.energyWh = val;
              telemetry.energyKwh = Number((val / 1000).toFixed(3));
            }
          } else if (mLower === "voltage") {
            if (phase === "L1") telemetry.voltageL1 = val;
            else if (phase === "L2") telemetry.voltageL2 = val;
            else if (phase === "L3") telemetry.voltageL3 = val;
            telemetry.voltage = val;
          } else if (mLower.includes("current.import") || mLower === "current") {
            if (phase === "L1") telemetry.currentL1 = val;
            else if (phase === "L2") telemetry.currentL2 = val;
            else if (phase === "L3") telemetry.currentL3 = val;
            else if (!phase) telemetry.currentL1 = val;
          } else if (mLower === "temperature") {
            telemetry.temperatureC = val;
          } else if (mLower === "soc") {
            telemetry.soc = val;
          }
        }
      }
    }

    const meterResult = await saveMeterValues(chargePointId, connectorId, transactionId, telemetry);

    // Auto-stop limit evaluation
    if (meterResult && meterResult.resolvedTxId) {
      await enforceAutoStopIfTargetReached(chargePointId, connectorId, meterResult);
    }

    return {};
  },

  /**
   * Data Transfer (Vendor-specific messages)
   */
  async DataTransfer(chargePointId, payload) {
    const { vendorId, messageId, data } = payload;
    console.log(`[OCPP] DataTransfer from ${chargePointId} [${vendorId}/${messageId}]:`, data);
    return {
      status: "Accepted",
      data: "",
    };
  },

  /**
   * Firmware Status Notification
   */
  async FirmwareStatusNotification(chargePointId, payload) {
    const { status } = payload;
    console.log(`[OCPP] FirmwareStatusNotification from ${chargePointId}: ${status}`);
    return {};
  },

  /**
   * Diagnostics Status Notification
   */
  async DiagnosticsStatusNotification(chargePointId, payload) {
    const { status } = payload;
    console.log(`[OCPP] DiagnosticsStatusNotification from ${chargePointId}: ${status}`);
    return {};
  },
};
