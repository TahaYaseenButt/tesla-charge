import express from "express";
import os from "os";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { ocppServer } from "../ocpp/OCPPServer.js";
import { db } from "../database/db.js";
import { getLocalChargerLive, liveEvents } from "../services/localSync.js";

export const apiRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "tesla-charge-local-secret-key-2026";

// Auth middleware for protected routes
export function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    req.user = null;
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) req.user = null;
    else req.user = user;
    next();
  });
}

// ==========================================
// 1. AUTHENTICATION (Replacing Firebase Auth)
// ==========================================

apiRouter.post("/auth/register", async (req, res) => {
  const { email, password, displayName, stationId } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Email and password are required" });
  }

  try {
    const existing = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email.trim());
    if (existing) {
      return res.status(409).json({ success: false, error: "User with this email already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const userId = "usr_" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    const now = new Date().toISOString();
    const assignedStation = (stationId || "charger1").trim().toLowerCase();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, display_name, role, station_id, created_at)
      VALUES (?, ?, ?, ?, 'user', ?, ?)
    `).run(userId, email.trim(), passwordHash, displayName || email.split("@")[0], assignedStation, now);

    const user = {
      uid: userId,
      id: userId,
      email: email.trim(),
      displayName: displayName || email.split("@")[0],
      stationId: assignedStation,
    };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: "90d" });

    return res.json({ success: true, token, user });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Email and password are required" });
  }

  try {
    const userRow = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email.trim());
    if (!userRow) {
      return res.status(401).json({ success: false, error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, userRow.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: "Invalid email or password" });
    }

    const stationId = userRow.station_id || "charger1";

    const user = {
      uid: userRow.id,
      id: userRow.id,
      email: userRow.email,
      displayName: userRow.display_name || userRow.email.split("@")[0],
      role: userRow.role,
      stationId,
    };

    const token = jwt.sign(user, JWT_SECRET, { expiresIn: "90d" });
    return res.json({ success: true, token, user });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.get("/auth/me", authenticateToken, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  const userRow = db.prepare("SELECT id, email, display_name, role, station_id, created_at FROM users WHERE id = ?").get(req.user.id || req.user.uid);
  if (!userRow) {
    return res.status(404).json({ success: false, error: "User not found" });
  }
  return res.json({
    success: true,
    user: {
      uid: userRow.id,
      id: userRow.id,
      email: userRow.email,
      displayName: userRow.display_name,
      role: userRow.role,
      stationId: userRow.station_id || "charger1",
    },
  });
});

// ==========================================
// 2. LIVE SYSTEM STATUS & CHARGERS
// ==========================================

apiRouter.get("/status", authenticateToken, (req, res) => {
  const targetId = String(req.query.chargerId || req.user?.stationId || "charger1").toLowerCase();
  const live = getLocalChargerLive(targetId);
  const connectedList = ocppServer.getConnectedChargers();
  const isConnected = connectedList.some((c) => c.chargePointId.toLowerCase() === targetId);

  // If WebSocket is actively connected, enforce Online in output
  if (isConnected) {
    live.charger.status = "Online";
  }

  const cpus = os.cpus();
  const loadAvg = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const procMem = process.memoryUsage();

  res.json({
    success: true,
    server: "OCPP 1.6-J Standalone Server (Direct)",
    status: "Online",
    targetChargerId: targetId,
    isConnected,
    charger: live.charger,
    connectors: live.connectors,
    activeTransaction: live.activeTransaction,
    lastCompletedTx: live.lastCompletedTx,
    serverTime: new Date().toISOString(),
    live,
    connectedChargers: connectedList,
    recentLogs: typeof ocppServer.getLogs === "function" ? ocppServer.getLogs(30) : (ocppServer.logs || []),
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptimeSeconds: Math.round(os.uptime()),
      cpuModel: cpus[0]?.model || "Unknown",
      cpuCores: cpus.length,
      cpuUsagePercent: Math.round(((loadAvg[0] || 0.5) / cpus.length) * 100),
      loadAverage: {
        "1m": Number(loadAvg[0].toFixed(2)),
        "5m": Number(loadAvg[1].toFixed(2)),
        "15m": Number(loadAvg[2].toFixed(2)),
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

apiRouter.get("/chargers", authenticateToken, (req, res) => {
  try {
    let chargers = db.prepare("SELECT * FROM chargers").all();

    // Tenant isolation: non-admin users only see their assigned station(s)
    if (req.user && req.user.role !== "admin") {
      const userStation = (req.user.stationId || req.user.station_id || "").toLowerCase();
      chargers = chargers.filter(
        (ch) =>
          ch.charge_point_id.toLowerCase() === userStation ||
          ch.configured_by_user_id === req.user.id ||
          (req.user.email && ch.configured_by_user_email?.toLowerCase() === req.user.email.toLowerCase())
      );
    }

    const result = chargers.map((ch) => {
      const live = getLocalChargerLive(ch.charge_point_id);
      return {
        id: ch.charge_point_id,
        chargePointId: ch.charge_point_id,
        model: ch.model,
        displayModel: ch.display_model,
        vendor: ch.vendor,
        tariffRate: ch.tariff_rate,
        currency: ch.currency,
        status: ch.status,
        configuredByUserId: ch.configured_by_user_id,
        configuredByUserEmail: ch.configured_by_user_email,
        connectors: live.connectors,
        activeTransaction: live.activeTransaction,
        lastCompletedTx: live.lastCompletedTx,
      };
    });
    return res.json({ success: true, chargers: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.get("/chargers/:chargePointId", (req, res) => {
  const { chargePointId } = req.params;
  const live = getLocalChargerLive(chargePointId);
  return res.json({ success: true, ...live });
});

const handleTariffUpdate = (req, res) => {
  const { chargePointId } = req.params;
  const { tariffRate } = req.body;
  if (!tariffRate || Number(tariffRate) <= 0) {
    return res.status(400).json({ success: false, error: "Valid tariffRate required" });
  }

  const cleanId = chargePointId.toLowerCase();

  // Tenant authorization check
  if (req.user && req.user.role !== "admin") {
    const userStation = (req.user.stationId || req.user.station_id || "").toLowerCase();
    const charger = db.prepare("SELECT configured_by_user_id, configured_by_user_email FROM chargers WHERE charge_point_id = ?").get(cleanId);
    const isOwner =
      userStation === cleanId ||
      (charger && charger.configured_by_user_id === req.user.id) ||
      (charger && req.user.email && charger.configured_by_user_email?.toLowerCase() === req.user.email.toLowerCase());

    if (!isOwner) {
      console.warn(`[Security Alert] User ${req.user.email} attempted unauthorized tariff change on [${cleanId}]`);
      return res.status(403).json({
        success: false,
        error: `Forbidden: You do not have permission to modify tariff for charger [${cleanId}].`,
      });
    }
  }

  try {
    db.prepare("UPDATE chargers SET tariff_rate = ?, updated_at = ? WHERE charge_point_id = ?")
      .run(Number(tariffRate), new Date().toISOString(), cleanId);
    return res.json({ success: true, tariffRate: Number(tariffRate) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

apiRouter.post("/chargers/:chargePointId/tariff", authenticateToken, handleTariffUpdate);
apiRouter.patch("/chargers/:chargePointId/tariff", authenticateToken, handleTariffUpdate);

// ==========================================
// 3. DIRECT REMOTE COMMANDS (Zero Firestore Polling!)
// ==========================================

apiRouter.post("/commands/dispatch", authenticateToken, async (req, res) => {
  const action = req.body.action || req.body.command;
  const params = req.body.parameters || {};
  const chargePointId = req.body.chargePointId || params.chargePointId;
  const connectorId = req.body.connectorId || params.connectorId;
  const transactionId = req.body.transactionId || params.transactionId;
  const idTag = req.body.idTag || params.idTag;
  const targetKwh = req.body.targetKwh || params.targetKwh;
  const targetPrice = req.body.targetPrice || params.targetPrice;
  const targetMinutes = req.body.targetMinutes || params.targetMinutes;

  const safeId = (chargePointId || "charger1").toLowerCase();
  const connId = Number(connectorId || 1);

  // Tenant authorization check
  if (req.user && req.user.role !== "admin") {
    const userStation = (req.user.stationId || req.user.station_id || "").toLowerCase();
    const charger = db.prepare("SELECT configured_by_user_id, configured_by_user_email FROM chargers WHERE charge_point_id = ?").get(safeId);
    const isAuthorized =
      !userStation ||
      userStation === safeId ||
      (charger && charger.configured_by_user_id === req.user.id) ||
      (charger && req.user.email && charger.configured_by_user_email?.toLowerCase() === req.user.email.toLowerCase());

    if (!isAuthorized) {
      console.warn(`[Security Alert] User ${req.user.email} attempted unauthorized command on [${safeId}]`);
      return res.status(403).json({
        success: false,
        error: `Forbidden: You are not authorized to control charger [${safeId}].`,
      });
    }
  }

  console.log(`[Command Dispatch] Action: ${action} on [${safeId}] Gun ${connId} by user: ${req.user?.email || "App"}`);

  try {
    let result = null;

    if (action === "UnlockConnector") {
      result = await ocppServer.unlockConnector(safeId, connId);
      if (result?.status === "UnlockFailed") {
        return res.status(400).json({ success: false, error: "Cable latch could not be released. Relieve tension on cable and retry." });
      }
      return res.json({ success: true, result, response: result });
    }

    if (action === "RemoteStartTransaction") {
      const connectedList = ocppServer.getConnectedChargers();
      const isConnected = connectedList.some((c) => c.chargePointId.toLowerCase() === safeId);
      if (!isConnected) {
        return res.status(400).json({ success: false, error: `Charger [${safeId}] is currently offline.` });
      }

      // Check connector availability
      const conn = db.prepare("SELECT status FROM connectors WHERE charge_point_id = ? AND connector_id = ?").get(safeId, connId);
      if (conn?.status === "Charging") {
        return res.status(400).json({ success: false, error: `Gun ${connId} is already charging another vehicle.` });
      }

      const effectiveIdTag = idTag || req.user?.email || "AppUser";

      // If user specified limits, record them for auto-stop safety interlock
      if (targetKwh || targetPrice || targetMinutes) {
        db.prepare(`
          INSERT INTO commands (id, charge_point_id, action, connector_id, user_id, user_email, created_at, updated_at)
          VALUES (?, ?, 'LimitConfig', ?, ?, ?, ?, ?)
        `).run(
          "lim_" + Date.now(),
          safeId,
          connId,
          req.user?.id || "App",
          req.user?.email || effectiveIdTag,
          new Date().toISOString(),
          new Date().toISOString()
        );
      }

      result = await ocppServer.remoteStartTransaction(safeId, connId, effectiveIdTag);
      return res.json({ success: true, result, response: result });
    }

    if (action === "RemoteStopTransaction") {
      let txId = transactionId;
      if (!txId) {
        const active = db.prepare(`
          SELECT transaction_id FROM transactions
          WHERE charge_point_id = ? AND connector_id = ? AND status = 'Charging'
          ORDER BY start_time DESC LIMIT 1
        `).get(safeId, connId);
        txId = active?.transaction_id;
      }

      if (!txId) {
        // Fallback: check any active transaction on this charger
        const activeAny = db.prepare(`
          SELECT transaction_id FROM transactions
          WHERE charge_point_id = ? AND status = 'Charging'
          ORDER BY start_time DESC LIMIT 1
        `).get(safeId);
        txId = activeAny?.transaction_id;
      }

      if (!txId) {
        return res.status(400).json({ success: false, error: "No active charging session found to stop." });
      }

      result = await ocppServer.remoteStopTransaction(safeId, Number(txId));

      // Auto-unlock cable after 1 second
      setTimeout(async () => {
        try {
          await ocppServer.unlockConnector(safeId, connId);
        } catch (_uErr) {}
      }, 1000);

      return res.json({ success: true, result, response: result });
    }

    if (action === "Reset") {
      result = await ocppServer.reset(safeId, req.body.type || "Soft");
      return res.json({ success: true, result, response: result });
    }

    return res.status(400).json({ success: false, error: `Unsupported action: ${action}` });
  } catch (err) {
    console.error(`[Command Dispatch Error]:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Shortcuts
apiRouter.post("/chargers/:chargePointId/unlock", authenticateToken, async (req, res) => {
  const { chargePointId } = req.params;
  const connectorId = req.body.connectorId || 1;
  const safeId = chargePointId.toLowerCase();

  if (req.user && req.user.role !== "admin") {
    const userStation = (req.user.stationId || req.user.station_id || "").toLowerCase();
    const charger = db.prepare("SELECT configured_by_user_id, configured_by_user_email FROM chargers WHERE charge_point_id = ?").get(safeId);
    const isAuthorized =
      !userStation ||
      userStation === safeId ||
      (charger && charger.configured_by_user_id === req.user.id) ||
      (charger && req.user.email && charger.configured_by_user_email?.toLowerCase() === req.user.email.toLowerCase());

    if (!isAuthorized) {
      return res.status(403).json({ success: false, error: "Forbidden: Cannot unlock another user's charger." });
    }
  }

  try {
    const result = await ocppServer.unlockConnector(safeId, connectorId);
    return res.json({ success: true, result, response: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.post("/chargers/:chargePointId/stop", authenticateToken, async (req, res) => {
  const { chargePointId } = req.params;
  const connectorId = req.body.connectorId || 1;
  const safeId = chargePointId.toLowerCase();

  if (req.user && req.user.role !== "admin") {
    const userStation = (req.user.stationId || req.user.station_id || "").toLowerCase();
    const charger = db.prepare("SELECT configured_by_user_id, configured_by_user_email FROM chargers WHERE charge_point_id = ?").get(safeId);
    const isAuthorized =
      !userStation ||
      userStation === safeId ||
      (charger && charger.configured_by_user_id === req.user.id) ||
      (charger && req.user.email && charger.configured_by_user_email?.toLowerCase() === req.user.email.toLowerCase());

    if (!isAuthorized) {
      return res.status(403).json({ success: false, error: "Forbidden: Cannot stop another user's session." });
    }
  }

  try {
    const active = db.prepare(`
      SELECT transaction_id FROM transactions
      WHERE charge_point_id = ? AND connector_id = ? AND status = 'Charging'
      ORDER BY start_time DESC LIMIT 1
    `).get(safeId, connectorId);

    const txId = req.body.transactionId || active?.transaction_id;
    if (!txId) {
      return res.status(400).json({ success: false, error: "No active session to stop" });
    }

    const result = await ocppServer.remoteStopTransaction(safeId, Number(txId));
    setTimeout(async () => {
      try { await ocppServer.unlockConnector(safeId, connectorId); } catch (_e) {}
    }, 1000);

    return res.json({ success: true, result, response: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 4. TRANSACTION HISTORY
// ==========================================

apiRouter.get("/transactions", authenticateToken, (req, res) => {
  try {
    let { chargePointId, limit = 50 } = req.query;
    let query = "SELECT * FROM transactions";
    const params = [];

    // Tenant isolation: if user is logged in and not admin, default to their assigned station
    if (req.user && req.user.role !== "admin") {
      const userStation = (req.user.stationId || req.user.station_id || "").toLowerCase();
      if (!chargePointId && userStation) {
        chargePointId = userStation;
      }
    }

    if (chargePointId) {
      query += " WHERE charge_point_id = ?";
      params.push(chargePointId.toLowerCase());
    }

    query += " ORDER BY start_time DESC LIMIT ?";
    params.push(Number(limit) || 50);

    const rows = db.prepare(query).all(...params);
    const transactions = rows.map((r) => ({
      id: r.transaction_id,
      transactionId: Number(r.transaction_id) || r.transaction_id,
      chargePointId: r.charge_point_id,
      connectorId: r.connector_id,
      userId: r.user_id,
      userEmail: r.user_email,
      idTag: r.id_tag,
      status: r.status,
      startTime: r.start_time,
      stopTime: r.stop_time,
      meterStart: r.meter_start,
      meterStop: r.meter_stop,
      energyDeliveredKwh: r.energy_delivered_kwh,
      energyDeliveredWh: r.energy_delivered_wh,
      cost: r.cost,
      tariffRate: r.tariff_rate,
      paymentStatus: r.payment_status,
      reason: r.reason,
      stopReason: r.reason,
    }));

    return res.json({ success: true, transactions });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 5. REAL-TIME SERVER-SENT EVENTS (SSE) STREAM
// ==========================================

apiRouter.get("/live/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  // Send initial snapshot
  const initial = getLocalChargerLive("charger1");
  res.write(`data: ${JSON.stringify({ type: "snapshot", data: initial })}\n\n`);

  const onUpdate = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  liveEvents.on("update", onUpdate);

  // Keep-alive heartbeat comment every 20 seconds
  const keepAlive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    liveEvents.off("update", onUpdate);
  });
});

// ==========================================
// 6. RFID TAGS
// ==========================================

apiRouter.get("/chargers/:chargePointId/rfid-tags", (_req, res) => {
  try {
    const tags = db.prepare("SELECT * FROM rfid_tags").all();
    return res.json({ success: true, tags });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.post("/chargers/:chargePointId/rfid-tags", authenticateToken, (req, res) => {
  const { chargePointId } = req.params;
  const { tagId, userEmail } = req.body;
  if (!tagId) return res.status(400).json({ success: false, error: "tagId is required" });

  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO rfid_tags (tag_id, charge_point_id, user_id, user_email, status, created_at)
      VALUES (?, ?, ?, ?, 'Accepted', ?)
      ON CONFLICT(tag_id) DO UPDATE SET
        user_email = excluded.user_email,
        status = 'Accepted'
    `).run(tagId.trim(), chargePointId.toLowerCase(), req.user?.id || "Admin", userEmail || req.user?.email || "Card", now);

    return res.json({ success: true, message: `RFID Tag ${tagId} registered successfully` });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.delete("/chargers/:chargePointId/rfid-tags/:tagId", authenticateToken, (req, res) => {
  const { tagId } = req.params;
  if (!tagId) return res.status(400).json({ success: false, error: "tagId is required" });

  try {
    db.prepare("DELETE FROM rfid_tags WHERE tag_id = ?").run(tagId.trim());
    return res.json({ success: true, message: `RFID Tag ${tagId} deleted successfully` });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 7. PUSH NOTIFICATION TOKEN REGISTRY
// ==========================================

apiRouter.post("/notifications/register-token", (req, res) => {
  const { token, chargerId, userId, platform } = req.body;
  if (!token) {
    return res.status(400).json({ success: false, error: "Push token is required" });
  }

  const cId = (chargerId || "charger1").toLowerCase();
  const now = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO push_tokens (token, charge_point_id, user_id, platform, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET
        charge_point_id = excluded.charge_point_id,
        user_id = excluded.user_id,
        platform = excluded.platform,
        updated_at = excluded.updated_at
    `).run(token.trim(), cId, userId || "anonymous", platform || "unknown", now, now);

    return res.json({ success: true, message: "Push token registered successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


