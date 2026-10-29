import {
  saveChargerBoot,
  saveChargerHeartbeat,
  saveConnectorStatus,
  saveMeterValues,
  saveStartTransaction,
  saveStopTransaction,
  verifyRfidTag,
} from "../services/firebaseSync.js";

// Helper to generate transaction IDs
let nextTxId = Date.now() % 1000000;

/**
 * Evaluates session limits with GSM predictive latency compensation.
 * Uses strictly '>=' (never '==') so large energy or price steps never bypass the limit.
 */
async function enforceAutoStopIfTargetReached(chargePointId, connectorId, meterResult) {
  try {
    if (!meterResult || !meterResult.resolvedTxId) return;
    const { resolvedTxId, sessionEnergyKwh, liveCost, powerKw, soc, activeTx, effectiveTariff } = meterResult;
    if (!activeTx) return;

    // Skip if already in the process of stopping or finished
    if (activeTx.isStopping || activeTx.status === "Finishing" || activeTx.status === "Completed") {
      return;
    }

    const targetPrice = activeTx.targetPrice ? Number(activeTx.targetPrice) : null;
    const targetKwh = activeTx.targetKwh ? Number(activeTx.targetKwh) : null;
    const targetMinutes = activeTx.targetMinutes ? Number(activeTx.targetMinutes) : null;
    const targetSoc = activeTx.targetSoc ? Number(activeTx.targetSoc) : null;

    if (!targetPrice && !targetKwh && !targetMinutes && !targetSoc) {
      return;
    }

    const kw = Number(powerKw) || 0;
    const tariff = Number(effectiveTariff) || 125;

    // GSM Network Latency Compensation:
    // Lead time of 5 seconds compensates for GSM packet transit (2-3s) + OCPP RemoteStop command delivery (2-3s).
    // At high DC power (e.g. 60-120 kW), energy and cost rise by 25-40 PKR between telemetry packets.
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

    // 3. Time Limit check (Minutes)
    if (!shouldStop && targetMinutes && targetMinutes > 0 && activeTx.startTime) {
      const elapsedMinutes = Math.max(0, (Date.now() - new Date(activeTx.startTime).getTime()) / 60000);
      if (elapsedMinutes >= targetMinutes) {
        shouldStop = true;
        stopReason = `Time limit reached: ${elapsedMinutes.toFixed(1)} min >= target ${targetMinutes} min`;
      }
    }

    // 4. Battery State of Charge Limit check (%)
    if (!shouldStop && targetSoc && targetSoc > 0 && typeof soc === 'number' && soc > 0) {
      if (soc >= targetSoc) {
        shouldStop = true;
        stopReason = `Battery SoC limit reached: ${soc}% >= target ${targetSoc}%`;
      }
    }

    if (shouldStop) {
      console.log(`[Safety Interlock] >>> AUTO-STOPPING: ${stopReason} on [${chargePointId}] Gun ${connectorId} (Tx #${resolvedTxId}) <<<`);

      // Set stopping flags immediately in RTDB so rapid packets do not trigger duplicate stops
      try {
        const { ref, update } = await import("firebase/database");
        const { rtdb } = await import("../config/firebase.js");
        const safeKey = (id) => String(id).replace(/[.#$[\]/]/g, "_");
        const stopUpdates = {};
        stopUpdates[`live/${safeKey(chargePointId)}/activeTx/${connectorId}/isStopping`] = true;
        stopUpdates[`live/${safeKey(chargePointId)}/activeTx/${connectorId}/status`] = "Finishing";
        stopUpdates[`live/${safeKey(chargePointId)}/activeTx/${connectorId}/stopReason`] = stopReason;
        stopUpdates[`live/${safeKey(chargePointId)}/connectors/${connectorId}/status`] = "Finishing";
        stopUpdates[`live/${safeKey(chargePointId)}/connectors/${connectorId}/info`] = `Stopping: ${stopReason}`;
        await update(ref(rtdb), stopUpdates);
      } catch (_flagErr) {}

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
  /**
   * Charger powers on or connects
   */
  async BootNotification(chargePointId, payload) {
    console.log(`[OCPP] BootNotification from ${chargePointId}:`, payload);
    // Persist boot info asynchronously so hardware receives an instant OCPP ACK
    saveChargerBoot(chargePointId, payload).catch((err) =>
      console.warn(`[OCPP] Async saveChargerBoot warning: ${err.message}`)
    );

    // Hardware sends Heartbeat, StatusNotification, and MeterValues per its own internal schedule.
    // We avoid sending unsolicited ChangeConfiguration on boot because embedded GSM modems
    // often restart their network stack/reboot upon receiving configuration changes.

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
      console.warn(`[OCPP] Async saveChargerHeartbeat warning: ${err.message}`)
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
      console.warn(`[OCPP] Async saveConnectorStatus warning: ${err.message}`)
    );
    return {};
  },

  /**
   * RFID or app authorization request
   */
  async Authorize(chargePointId, payload) {
    const { idTag } = payload;
    console.log(`[OCPP] Authorize request on ${chargePointId} for tag: ${idTag}`);
    const authResult = await verifyRfidTag(chargePointId, idTag);

    let parentId = idTag;
    let activeTxToStop = null;
    try {
      const { get, ref } = await import("firebase/database");
      const { rtdb, db } = await import("../config/firebase.js");
      const safeKey = (id) => String(id).replace(/[.#$[\]/]/g, "_");
      const snap = await get(ref(rtdb, `live/${safeKey(chargePointId)}/activeTx`));
      if (snap.exists()) {
        const activeMap = snap.val() || {};
        for (const connKey of Object.keys(activeMap)) {
          const act = activeMap[connKey];
          if (act && act.transactionId) {
            parentId = act.idTag || idTag;
            activeTxToStop = act;
            break;
          }
        }
      }

      // Fallback: check Firestore transactions collection for active session
      if (!activeTxToStop) {
        const { collection, query, where, getDocs, limit } = await import("firebase/firestore");
        const qActive = query(
          collection(db, "transactions"),
          where("chargePointId", "==", chargePointId),
          where("status", "==", "Charging"),
          limit(1)
        );
        const qSnap = await getDocs(qActive);
        if (!qSnap.empty) {
          const tDoc = qSnap.docs[0].data();
          activeTxToStop = { transactionId: tDoc.transactionId || qSnap.docs[0].id, ...tDoc };
          parentId = tDoc.idTag || idTag;
        }
      }
    } catch (_e) {}

    // If an authorized RFID tag was tapped while charging, trigger remote stop as fail-safe
    if (authResult.status === "Accepted" && activeTxToStop && activeTxToStop.transactionId) {
      console.log(`[OCPP] Authorized RFID tag ${idTag} tapped while Tx #${activeTxToStop.transactionId} is charging -> Dispatching remote stop`);
      const targetConn = Number(activeTxToStop.connectorId || 1);
      setTimeout(async () => {
        try {
          const { ocppServer } = await import("./OCPPServer.js");
          await ocppServer.remoteStopTransaction(chargePointId, Number(activeTxToStop.transactionId));
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
        expiryDate:
          authResult.expiryDate ||
          new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      },
    };
  },

  /**
   * Charging session started
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

    // Cellular Deduplication: Check if this connector already has an active session with identical meterStart or timestamp
    try {
      const { getDatabase, ref, get } = await import("firebase/database");
      const { rtdb } = await import("../config/firebase.js");
      const connTxSnap = await get(ref(rtdb, `live/${chargePointId.toLowerCase()}/connectors/${connectorId}/activeTx`));
      if (connTxSnap.exists()) {
        const active = connTxSnap.val() || {};
        const isMeterMatch = Math.abs(Number(active.meterStart || 0) - Number(meterStart || 0)) < 50;
        const isTimeMatch = active.startTime === timestamp;
        if (active.transactionId && (isMeterMatch || isTimeMatch)) {
          console.log(`[OCPP] Deduplicated StartTransaction retry for ${chargePointId} [Connector ${connectorId}] -> Reusing TxId #${active.transactionId}`);
          return {
            transactionId: Number(active.transactionId),
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
      },
    };
  },

  /**
   * Charging session stopped
   */
  async StopTransaction(chargePointId, payload) {
    const { transactionId, meterStop, timestamp, reason } = payload;
    const pricePerKwh = parseFloat(process.env.PRICE_PER_KWH || "0.30");

    console.log(
      `[OCPP] StopTransaction on ${chargePointId}, TxId: ${transactionId}, MeterStop: ${meterStop}, Reason: ${reason}`
    );

    const result = await saveStopTransaction(
      transactionId,
      chargePointId,
      meterStop,
      timestamp,
      reason,
      null // Uses charger's configured tariffRate from Firestore
    );

    // Automatically unlock cable immediately on stop (no payment required)
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
   * Real-time meter telemetry (Power kW, Voltage, Amps, Energy Wh, Temperature, SoC)
   */
  async MeterValues(chargePointId, payload) {
    const { connectorId, transactionId, meterValue } = payload;

    const telemetry = {
      powerKw: 0,
      energyWh: 0,
      energyKwh: 0,
      voltage: 0,
      voltageL1: 0,
      voltageL2: 0,
      voltageL3: 0,
      currentL1: 0,
      currentL2: 0,
      currentL3: 0,
      temperatureC: null,
      soc: null,
      raw: meterValue,
    };

    if (Array.isArray(meterValue)) {
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

    // Auto-Stop Safety Interlock: Multi-metric checks (Price, kWh, Time, SoC) with GSM predictive latency compensation
    await enforceAutoStopIfTargetReached(chargePointId, connectorId || 1, meterResult);

    return {};
  },

  /**
   * Vendor-specific data transfer
   */
  async DataTransfer(chargePointId, payload) {
    console.log(`[OCPP] DataTransfer from ${chargePointId}:`, payload);
    return {
      status: "Accepted",
      data: "OK",
    };
  },

  async DiagnosticsStatusNotification(_chargePointId, _payload) {
    return {};
  },

  async FirmwareStatusNotification(_chargePointId, _payload) {
    return {};
  },
};
