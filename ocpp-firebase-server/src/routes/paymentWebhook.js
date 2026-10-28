import express from "express";
import os from "os";
import { ocppServer } from "../ocpp/OCPPServer.js";
import { updateTransactionPayment, getChargerLiveState, getLocalServerTransactions } from "../services/firebaseSync.js";
import { db, rtdb } from "../config/firebase.js";
import { collection, getDocs, doc, getDoc, query, orderBy, limit } from "firebase/firestore";
import { ref, get } from "firebase/database";

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
  let transactionId = req.body?.transactionId;

  try {
    if (!transactionId) {
      const live = await getChargerLiveState(chargePointId);
      transactionId = live?.activeTx?.["1"]?.transactionId || 
                      live?.activeTx?.["2"]?.transactionId || 
                      live?.activeTx?.transactionId;
    }
    const result = await ocppServer.remoteStopTransaction(chargePointId, transactionId);
    // Auto-unlock connector immediately on stop (no payment required)
    setTimeout(async () => {
      try {
        await ocppServer.unlockConnector(chargePointId, req.body?.connectorId || 1);
      } catch (_e) {}
    }, 1000);
    return res.json({ success: true, result, stoppedTransactionId: transactionId });
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
 * Server status, connected chargers list, and live telemetry + Hardware Diagnostics
 */
apiRouter.get("/status", async (req, res) => {
  const cpus = os.cpus() || [];
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  let totalIdle = 0, totalTick = 0;
  cpus.forEach((cpu) => {
    for (const type in cpu.times) { totalTick += cpu.times[type]; }
    totalIdle += cpu.times.idle;
  });
  const cpuUsagePercent = Math.max(0, Math.min(100, Math.round((1 - totalIdle / (totalTick || 1)) * 100)));
  const procMem = process.memoryUsage();
  const loadAvg = os.loadavg();

  const targetChargerId = String(req.query.chargerId || "charger1").toLowerCase();
  const conn = ocppServer.connections.get(targetChargerId);
  const isConnected = Boolean(conn && conn.ws && conn.ws.readyState === 1);
  const live = await getChargerLiveState(targetChargerId);

  return res.json({
    server: "OCPP 1.6-J Firebase Server",
    status: "Online",
    targetChargerId,
    isConnected,
    live,
    connectedChargers: ocppServer.getConnectedChargers(),
    recentLogs: ocppServer.logs,
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptimeSeconds: Math.round(os.uptime()),
      cpuModel: cpus[0]?.model || "Generic CPU",
      cpuCores: cpus.length,
      cpuUsagePercent,
      loadAverage: {
        "1m": parseFloat(loadAvg[0].toFixed(2)),
        "5m": parseFloat(loadAvg[1].toFixed(2)),
        "15m": parseFloat(loadAvg[2].toFixed(2)),
      },
      ramTotalMB: Math.round(totalMem / (1024 * 1024)),
      ramUsedMB: Math.round(usedMem / (1024 * 1024)),
      ramFreeMB: Math.round(freeMem / (1024 * 1024)),
      ramUsagePercent: Math.round((usedMem / totalMem) * 100),
      pid: process.pid,
      nodeVersion: process.version,
      procUptimeSeconds: Math.round(process.uptime()),
      rssMB: Math.round(procMem.rss / (1024 * 1024)),
      heapUsedMB: Math.round(procMem.heapUsed / (1024 * 1024)),
      heapTotalMB: Math.round(procMem.heapTotal / (1024 * 1024)),
      totalConnections: ocppServer.connections.size,
    },
  });
});

/**
 * Fetch historical transactions stored locally on the server
 */
apiRouter.get("/chargers/:chargePointId/transactions", (req, res) => {
  const { chargePointId } = req.params;
  const cleanId = String(chargePointId || "charger1").toLowerCase();
  const allTx = getLocalServerTransactions();
  const filtered = allTx.filter((t) => !t.chargePointId || String(t.chargePointId).toLowerCase() === cleanId);
  return res.json({ success: true, count: filtered.length, transactions: filtered });
});

/**
 * Fine-grained Server Hardware, Load, Memory, and Network Metrics
 */
apiRouter.get("/system/metrics", (_req, res) => {
  const cpus = os.cpus() || [];
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsagePercent = Math.round((usedMem / totalMem) * 100);

  // Calculate overall CPU usage across cores
  let totalIdle = 0;
  let totalTick = 0;
  cpus.forEach((cpu) => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  const cpuUsagePercent = Math.max(0, Math.min(100, Math.round((1 - totalIdle / (totalTick || 1)) * 100)));

  const procMem = process.memoryUsage();
  const loadAvg = os.loadavg();

  return res.json({
    status: "Healthy",
    timestamp: new Date().toISOString(),
    os: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptimeSeconds: Math.round(os.uptime()),
    },
    hardware: {
      cpuModel: cpus[0]?.model || "Generic CPU",
      cpuCores: cpus.length,
      cpuUsagePercent,
      loadAverage: {
        "1m": parseFloat(loadAvg[0].toFixed(2)),
        "5m": parseFloat(loadAvg[1].toFixed(2)),
        "15m": parseFloat(loadAvg[2].toFixed(2)),
      },
      ramTotalMB: Math.round(totalMem / (1024 * 1024)),
      ramUsedMB: Math.round(usedMem / (1024 * 1024)),
      ramFreeMB: Math.round(freeMem / (1024 * 1024)),
      ramUsagePercent: memUsagePercent,
    },
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      rssMB: Math.round(procMem.rss / (1024 * 1024)),
      heapUsedMB: Math.round(procMem.heapUsed / (1024 * 1024)),
      heapTotalMB: Math.round(procMem.heapTotal / (1024 * 1024)),
    },
    ocpp: {
      totalConnections: ocppServer.connections.size,
      connectedChargers: ocppServer.getConnectedChargers(),
      recentLogsCount: ocppServer.logs.length,
    },
  });
});

/**
 * Helper to determine charger category and images
 */
function resolveChargerImages(modelStr, isConnectedA, isConnectedB) {
  const m = String(modelStr || "").toLowerCase();
  const is30kW = m.includes("30") || m.includes("single");
  const is60kW = m.includes("60");
  const is240kW = m.includes("240") || (!is30kW && !is60kW);

  let category = "240kW";
  let powerKw = 240;
  let modelImage = "/assets/images/models/charger_240kw.png";
  let stateImage = "/assets/images/states/state_240kw_idle.png";

  if (is30kW) {
    category = "30kW";
    powerKw = 30;
    modelImage = "/assets/images/models/charger_30kw.png";
    stateImage = isConnectedA ? "/assets/images/states/state_30kw_connected.png" : "/assets/images/states/state_30kw_idle.png";
  } else if (is60kW) {
    category = "60kW";
    powerKw = 60;
    modelImage = "/assets/images/models/charger_60kw.png";
    if (isConnectedA && isConnectedB) stateImage = "/assets/images/states/state_both.png";
    else if (isConnectedA) stateImage = "/assets/images/states/state_left.png";
    else if (isConnectedB) stateImage = "/assets/images/states/state_right.png";
    else stateImage = "/assets/images/states/state_idle.png";
  } else {
    // 240kW Ultra-Fast
    category = "240kW";
    powerKw = 240;
    modelImage = "/assets/images/models/charger_240kw.png";
    if (isConnectedA && isConnectedB) stateImage = "/assets/images/states/state_240kw_both.png";
    else if (isConnectedA) stateImage = "/assets/images/states/state_240kw_left.png";
    else if (isConnectedB) stateImage = "/assets/images/states/state_240kw_right.png";
    else stateImage = "/assets/images/states/state_240kw_idle.png";
  }

  return { category, powerKw, modelImage, stateImage, is30kW, is60kW, is240kW };
}

/**
 * GET /api/chargers
 * Returns all active and configured chargers with live telemetry, connectors, and images
 */
apiRouter.get("/chargers", async (_req, res) => {
  try {
    const chargersSnap = await getDocs(collection(db, "chargers"));
    const ocppConnected = ocppServer.getConnectedChargers();
    const result = [];

    for (const d of chargersSnap.docs) {
      const data = d.data();
      const id = d.id;

      // Skip stress test dummy stations
      if (id.startsWith("stress_charger_") || id.startsWith("traffic_check")) continue;

      // Fetch connectors
      let c1 = null, c2 = null;
      try {
        const c1Snap = await getDoc(doc(db, "chargers", id, "connectors", "1"));
        if (c1Snap.exists()) c1 = c1Snap.data();
      } catch (_e) {}
      try {
        const c2Snap = await getDoc(doc(db, "chargers", id, "connectors", "2"));
        if (c2Snap.exists()) c2 = c2Snap.data();
      } catch (_e) {}

      // Fetch RTDB live snapshot if available
      let live = {};
      try {
        const liveSnap = await get(ref(rtdb, `live/${id}`));
        if (liveSnap.exists()) live = liveSnap.val() || {};
      } catch (_e) {}

      const isConnectedToWs = ocppConnected.some((c) => c.chargePointId.toLowerCase() === id.toLowerCase());
      const lastHb = live.lastHeartbeat || data.lastHeartbeat;
      const isOnline = isConnectedToWs || (lastHb && (Date.now() - new Date(lastHb).getTime() < 300000));

      const status1 = c1?.status || data.connector_1_status || "Available";
      const status2 = c2?.status || data.connector_2_status || "Available";

      const isConnectedA = ["Charging", "Preparing", "SuspendedEV", "SuspendedEVSE", "Finishing"].includes(status1);
      const isConnectedB = ["Charging", "Preparing", "SuspendedEV", "SuspendedEVSE", "Finishing"].includes(status2);

      const images = resolveChargerImages(data.model, isConnectedA, isConnectedB);

      result.push({
        id,
        chargePointId: id,
        name: data.name || id.toUpperCase(),
        model: data.model || `${images.category} DC Charger`,
        vendor: data.vendor || "TeslaCharge",
        tariffRate: data.tariffRate || 125,
        currency: data.currency || "PKR",
        location: data.location || "Central Station",
        status: isOnline ? "Online" : "Offline",
        isOnline,
        lastHeartbeat: lastHb,
        category: images.category,
        powerRatingKw: data.powerRatingKw || images.powerKw,
        modelImage: images.modelImage,
        stateImage: images.stateImage,
        connectors: {
          "1": {
            id: 1,
            status: status1,
            powerKw: c1?.telemetry?.powerKw || 0,
            energyKwh: c1?.telemetry?.energyKwh || (c1?.telemetry?.energyWh ? c1.telemetry.energyWh / 1000 : 0),
            voltage: c1?.telemetry?.voltage || 0,
            current: c1?.telemetry?.currentL1 || 0,
            soc: c1?.telemetry?.soc || null,
            activeTx: c1?.activeTx || live?.activeTx?.["1"] || null,
          },
          ...(images.is30kW ? {} : {
            "2": {
              id: 2,
              status: status2,
              powerKw: c2?.telemetry?.powerKw || 0,
              energyKwh: c2?.telemetry?.energyKwh || (c2?.telemetry?.energyWh ? c2.telemetry.energyWh / 1000 : 0),
              voltage: c2?.telemetry?.voltage || 0,
              current: c2?.telemetry?.currentL1 || 0,
              soc: c2?.telemetry?.soc || null,
              activeTx: c2?.activeTx || live?.activeTx?.["2"] || null,
            }
          }),
        },
      });
    }

    return res.json({ success: true, count: result.length, chargers: result });
  } catch (err) {
    console.error("[API Error] /api/chargers:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/chargers/:chargePointId/history
 * Returns real session history for a specific charger
 */
apiRouter.get("/chargers/:chargePointId/history", async (req, res) => {
  try {
    const { chargePointId } = req.params;
    const cleanId = chargePointId.trim().toLowerCase();

    const q = query(
      collection(db, "transactions"),
      orderBy("startTime", "desc"),
      limit(100)
    );
    const snap = await getDocs(q);

    const history = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((tx) => {
        if (tx.chargePointId && tx.chargePointId.toLowerCase() !== cleanId) return false;
        const kwh = Number(tx.energyDeliveredKwh) || 0;
        return kwh > 0;
      });

    return res.json({ success: true, count: history.length, transactions: history });
  } catch (err) {
    console.error("[API Error] /api/chargers/:id/history:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/network-summary
 * Returns aggregated network metrics
 */
apiRouter.get("/network-summary", async (_req, res) => {
  try {
    const txSnap = await getDocs(query(collection(db, "transactions"), orderBy("startTime", "desc"), limit(200)));
    let totalKwh = 0;
    let totalCost = 0;
    let completedCount = 0;

    txSnap.docs.forEach((d) => {
      const data = d.data();
      const kwh = Number(data.energyDeliveredKwh) || 0;
      const cost = Number(data.cost) || 0;
      if (kwh > 0) {
        totalKwh += kwh;
        totalCost += cost;
        completedCount++;
      }
    });

    const ocppConnected = ocppServer.getConnectedChargers();

    return res.json({
      success: true,
      totalEnergyDeliveredKwh: Number(totalKwh.toFixed(2)),
      totalRevenuePkr: Math.round(totalCost),
      completedSessionsCount: completedCount,
      activeConnectionsCount: ocppConnected.length,
      connectedChargers: ocppConnected,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


