import express from "express";
import { ocppServer } from "../ocpp/OCPPServer.js";
import { updateTransactionPayment, getChargerLiveState } from "../services/firebaseSync.js";

export const apiRouter = express.Router();

/**
 * Bank Payment Webhook:
 * When bank confirms customer has paid the QR code:
 * 1. Mark transaction as Paid in Firestore
 * 2. Automatically sends UnlockConnector to charger!
 */
apiRouter.post("/payment-webhook", async (req, res) => {
  const { transactionId, chargePointId, connectorId, status, bankReference } = req.body;

  console.log(`[Bank Webhook] Payment notification received:`, req.body);

  if (!chargePointId) {
    return res.status(400).json({ error: "Missing chargePointId" });
  }

  try {
    // 1. Mark transaction paid in Firestore
    if (transactionId) {
      await updateTransactionPayment(transactionId, "Paid", bankReference || "BANK_WEBHOOK");
    }

    // 2. Automatically unlock the charger cable
    let unlockResult = null;
    try {
      unlockResult = await ocppServer.unlockConnector(chargePointId, connectorId || 1);
      console.log(`[Bank Webhook] Cable automatically UNLOCKED on [${chargePointId}]`);
    } catch (unlockErr) {
      console.warn(`[Bank Webhook] Failed to auto-unlock: ${unlockErr.message}`);
    }

    return res.json({
      success: true,
      message: "Payment recorded and cable unlocked successfully",
      unlockResult,
    });
  } catch (err) {
    console.error(`[Bank Webhook Error]:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Direct API to unlock connector
 */
apiRouter.post("/chargers/:chargePointId/unlock", async (req, res) => {
  const { chargePointId } = req.params;
  const connectorId = req.body.connectorId || 1;

  try {
    const result = await ocppServer.unlockConnector(chargePointId, connectorId);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Direct API to reboot charger
 */
apiRouter.post("/chargers/:chargePointId/reset", async (req, res) => {
  const { chargePointId } = req.params;
  const type = req.body.type || "Soft";

  try {
    const result = await ocppServer.reset(chargePointId, type);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Direct API to remote stop transaction
 */
apiRouter.post("/chargers/:chargePointId/stop", async (req, res) => {
  const { chargePointId } = req.params;
  const { transactionId } = req.body;

  try {
    const result = await ocppServer.remoteStopTransaction(chargePointId, transactionId);
    // Auto-unlock connector immediately on stop (no payment required)
    setTimeout(async () => {
      try {
        await ocppServer.unlockConnector(chargePointId, 1);
      } catch (_e) {}
    }, 1000);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Direct API to remote start transaction
 */
apiRouter.post("/chargers/:chargePointId/start", async (req, res) => {
  const { chargePointId } = req.params;
  const connectorId = req.body.connectorId || 1;
  const idTag = req.body.idTag || "USER_APP_01";

  try {
    const result = await ocppServer.remoteStartTransaction(chargePointId, connectorId, idTag);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Direct API to change configuration on charger
 */
apiRouter.post("/chargers/:chargePointId/config", async (req, res) => {
  const { chargePointId } = req.params;
  const { key, value } = req.body;

  try {
    const result = await ocppServer.changeConfiguration(chargePointId, key, value);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Direct API to query configuration from charger
 */
apiRouter.get("/chargers/:chargePointId/config", async (req, res) => {
  const { chargePointId } = req.params;

  try {
    const result = await ocppServer.getConfiguration(chargePointId, []);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Direct API to trigger message (MeterValues, StatusNotification, etc.)
 */
apiRouter.post("/chargers/:chargePointId/trigger", async (req, res) => {
  const { chargePointId } = req.params;
  const { requestedMessage = "MeterValues", connectorId = 1 } = req.body;

  try {
    const result = await ocppServer.triggerMessage(chargePointId, requestedMessage, connectorId);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Fetch live charger state including telemetry and active transaction from Firestore
 */
apiRouter.get("/chargers/:chargePointId/live", async (req, res) => {
  const { chargePointId } = req.params;
  const data = await getChargerLiveState(chargePointId);
  return res.json({ success: true, ...data });
});

/**
 * Server status, connected chargers list, and live telemetry
 */
apiRouter.get("/status", async (_req, res) => {
  const connectedChargers = ocppServer.getConnectedChargers();
  const chargersWithData = await Promise.all(
    connectedChargers.map(async (c) => {
      const live = await getChargerLiveState(c.chargePointId);
      return {
        ...c,
        ...live,
      };
    })
  );

  return res.json({
    server: "OCPP 1.6-J Firebase Server",
    status: "Online",
    connectedChargers: chargersWithData,
    recentLogs: ocppServer.logs,
  });
});
