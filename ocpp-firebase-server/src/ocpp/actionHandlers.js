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

    // Auto-configure clock-aligned meter readings so charger streams telemetry even in idle/preparing
    setTimeout(async () => {
      try {
        const { ocppServer } = await import("./OCPPServer.js");
        await ocppServer.changeConfiguration(chargePointId, "ClockAlignedDataInterval", "15");
        await ocppServer.changeConfiguration(chargePointId, "MeterValueSampleInterval", "10");
        console.log(`[OCPP] Configured meter reporting intervals (15s) for [${chargePointId}]`);
      } catch (err) {
        console.warn(`[OCPP] Auto-config on boot:`, err.message);
      }
    }, 2000);

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

    await saveMeterValues(chargePointId, connectorId, transactionId, telemetry);

    // Auto-Stop Safety Interlock: If driver configured a target limit (kWh or budget), check if reached
    if (transactionId) {
      try {
        const { get, ref } = await import("firebase/database");
        const { rtdb } = await import("../config/firebase.js");
        const safeKey = (id) => String(id).replace(/[.#$[\]/]/g, "_");
        const activeSnap = await get(ref(rtdb, `live/${safeKey(chargePointId)}/activeTx/${connectorId || 1}`));
        if (activeSnap.exists()) {
          const active = activeSnap.val();
          if (active.targetKwh && active.meterStart) {
            const deliveredKwh = Math.max(0, (telemetry.energyWh - Number(active.meterStart)) / 1000);
            if (deliveredKwh >= active.targetKwh) {
              console.log(
                `[Safety Interlock] Target reached (${deliveredKwh.toFixed(2)} / ${active.targetKwh} kWh) on [${chargePointId}]. Auto-stopping session...`
              );
              const { ocppServer } = await import("./OCPPServer.js");
              await ocppServer.remoteStopTransaction(chargePointId, transactionId);
            }
          }
        }
      } catch (limitErr) {
        console.warn(`[Safety Interlock] Target check notice:`, limitErr.message);
      }
    }

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
