import {
  saveChargerBoot,
  saveChargerHeartbeat,
  saveConnectorStatus,
  saveMeterValues,
  saveStartTransaction,
  saveStopTransaction,
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
    await saveChargerBoot(chargePointId, payload);

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
    await saveChargerHeartbeat(chargePointId);
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
    await saveConnectorStatus(chargePointId, connectorId, status, errorCode, info);
    return {};
  },

  /**
   * RFID or app authorization request
   */
  async Authorize(chargePointId, payload) {
    const { idTag } = payload;
    console.log(`[OCPP] Authorize request on ${chargePointId} for tag: ${idTag}`);
    // You can check an authorized tags list, or accept all tags
    return {
      idTagInfo: {
        status: "Accepted",
        expiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      },
    };
  },

  /**
   * Charging session started
   */
  async StartTransaction(chargePointId, payload) {
    const { connectorId, idTag, meterStart, timestamp } = payload;
    const txId = ++nextTxId;

    console.log(
      `[OCPP] StartTransaction on ${chargePointId} [Connector ${connectorId}], TxId: ${txId}, MeterStart: ${meterStart}`
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
      pricePerKwh
    );

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
          const measurand = sample.measurand || "Energy.Active.Import.Register";
          const unit = (sample.unit || "").toUpperCase();
          const phase = sample.phase;

          if (measurand === "Power.Active.Import") {
            telemetry.powerKw = unit === "KW" ? val : Number((val / 1000).toFixed(2));
          } else if (measurand === "Energy.Active.Import.Register") {
            if (unit === "KWH") {
              telemetry.energyKwh = val;
              telemetry.energyWh = Math.round(val * 1000);
            } else {
              telemetry.energyWh = val;
              telemetry.energyKwh = Number((val / 1000).toFixed(3));
            }
          } else if (measurand === "Voltage") {
            if (phase === "L1") telemetry.voltageL1 = val;
            else if (phase === "L2") telemetry.voltageL2 = val;
            else if (phase === "L3") telemetry.voltageL3 = val;
            telemetry.voltage = val;
          } else if (measurand === "Current.Import") {
            if (phase === "L1") telemetry.currentL1 = val;
            else if (phase === "L2") telemetry.currentL2 = val;
            else if (phase === "L3") telemetry.currentL3 = val;
            else if (!phase) telemetry.currentL1 = val;
          } else if (measurand === "Temperature") {
            telemetry.temperatureC = val;
          } else if (measurand === "SoC") {
            telemetry.soc = val;
          }
        }
      }
    }

    await saveMeterValues(chargePointId, connectorId, transactionId, telemetry);
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
