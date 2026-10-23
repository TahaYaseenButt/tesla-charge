import { db } from "../config/firebase.js";
import { doc, setDoc, updateDoc, collection, addDoc, getDoc } from "firebase/firestore";

/**
 * Sync charger registration and boot notification
 */
export async function saveChargerBoot(chargePointId, data) {
  try {
    const chargerRef = doc(db, "chargers", chargePointId);
    await setDoc(
      chargerRef,
      {
        chargePointId,
        vendor: data.chargePointVendor || "Unknown",
        model: data.chargePointModel || "Unknown",
        firmwareVersion: data.firmwareVersion || "Unknown",
        meterType: data.meterType || "Unknown",
        status: "Online",
        lastHeartbeat: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    console.log(`[Firestore] Updated charger boot info: ${chargePointId}`);
  } catch (err) {
    console.error(`[Firestore Error] saveChargerBoot for ${chargePointId}:`, err.message);
  }
}

/**
 * Update heartbeat timestamp and connectivity status
 */
export async function saveChargerHeartbeat(chargePointId) {
  try {
    const chargerRef = doc(db, "chargers", chargePointId);
    await setDoc(
      chargerRef,
      {
        chargePointId,
        status: "Online",
        lastHeartbeat: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    console.error(`[Firestore Error] saveChargerHeartbeat for ${chargePointId}:`, err.message);
  }
}

/**
 * Update connector status (Available, Preparing, Charging, Faulted, etc.)
 */
export async function saveConnectorStatus(chargePointId, connectorId, status, errorCode, info) {
  try {
    const connectorRef = doc(db, "chargers", chargePointId, "connectors", String(connectorId));
    await setDoc(
      connectorRef,
      {
        connectorId: Number(connectorId),
        status,
        errorCode: errorCode || "NoError",
        info: info || "",
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    // Also update main charger document with connector summary
    const chargerRef = doc(db, "chargers", chargePointId);
    await setDoc(
      chargerRef,
      {
        [`connector_${connectorId}_status`]: status,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    console.log(`[Firestore] Charger ${chargePointId} Connector ${connectorId} status: ${status}`);
  } catch (err) {
    console.error(`[Firestore Error] saveConnectorStatus:`, err.message);
  }
}

/**
 * Save real-time telemetry (meter values: kW, V, A, Wh, SoC)
 */
export async function saveMeterValues(chargePointId, connectorId, transactionId, telemetryData) {
  try {
    const connectorRef = doc(db, "chargers", chargePointId, "connectors", String(connectorId));
    await setDoc(
      connectorRef,
      {
        telemetry: {
          ...telemetryData,
          updatedAt: new Date().toISOString(),
        },
      },
      { merge: true }
    );

    // If there is an active transaction, update its live reading as well
    if (transactionId) {
      const txRef = doc(db, "transactions", String(transactionId));
      await setDoc(
        txRef,
        {
          currentPowerKw: telemetryData.powerKw || 0,
          currentEnergyWh: telemetryData.energyWh || 0,
          lastTelemetryAt: new Date().toISOString(),
        },
        { merge: true }
      );
    }
  } catch (err) {
    console.error(`[Firestore Error] saveMeterValues:`, err.message);
  }
}

/**
 * Record start of a charging transaction
 */
export async function saveStartTransaction(transactionId, chargePointId, connectorId, idTag, meterStart, timestamp) {
  try {
    const txRef = doc(db, "transactions", String(transactionId));
    await setDoc(txRef, {
      transactionId: Number(transactionId),
      chargePointId,
      connectorId: Number(connectorId),
      idTag: idTag || "Anonymous",
      meterStart: Number(meterStart),
      startTime: timestamp || new Date().toISOString(),
      status: "Charging",
      paymentStatus: "Pending",
      paid: false,
      cost: 0,
      energyDeliveredKwh: 0,
      createdAt: new Date().toISOString(),
    });

    // Mark connector as charging
    await saveConnectorStatus(chargePointId, connectorId, "Charging", "NoError", `Transaction #${transactionId}`);
    console.log(`[Firestore] Created transaction #${transactionId} for charger ${chargePointId}`);
  } catch (err) {
    console.error(`[Firestore Error] saveStartTransaction:`, err.message);
  }
}

/**
 * Record stop of a transaction, calculate energy delivered and bill
 */
export async function saveStopTransaction(transactionId, chargePointId, meterStop, timestamp, reason, pricePerKwh = 0.3) {
  try {
    const txRef = doc(db, "transactions", String(transactionId));
    const txSnap = await getDoc(txRef);

    let meterStart = 0;
    if (txSnap.exists()) {
      meterStart = txSnap.data().meterStart || 0;
    }

    const energyDeliveredWh = Math.max(0, Number(meterStop) - Number(meterStart));
    const energyDeliveredKwh = Number((energyDeliveredWh / 1000).toFixed(2));
    const totalCost = Number((energyDeliveredKwh * pricePerKwh).toFixed(2));

    await setDoc(
      txRef,
      {
        stopTime: timestamp || new Date().toISOString(),
        meterStop: Number(meterStop),
        energyDeliveredWh,
        energyDeliveredKwh,
        cost: totalCost,
        status: "Completed",
        paymentStatus: "Pending", // Awaiting bank payment
        reason: reason || "Local",
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    console.log(
      `[Firestore] Stopped transaction #${transactionId}: ${energyDeliveredKwh} kWh delivered, Total: $${totalCost}`
    );

    return { energyDeliveredKwh, totalCost };
  } catch (err) {
    console.error(`[Firestore Error] saveStopTransaction:`, err.message);
    return { energyDeliveredKwh: 0, totalCost: 0 };
  }
}

/**
 * Update transaction payment status (e.g. from bank webhook)
 */
export async function updateTransactionPayment(transactionId, paymentStatus = "Paid", bankRef = "") {
  try {
    const txRef = doc(db, "transactions", String(transactionId));
    await setDoc(
      txRef,
      {
        paymentStatus,
        paid: paymentStatus === "Paid",
        bankReference: bankRef,
        paidAt: new Date().toISOString(),
      },
      { merge: true }
    );
    console.log(`[Firestore] Transaction #${transactionId} marked as ${paymentStatus}`);
  } catch (err) {
    console.error(`[Firestore Error] updateTransactionPayment:`, err.message);
  }
}
