import { WebSocketServer } from "ws";
import { actionHandlers } from "./actionHandlers.js";
import { saveChargerOffline, saveChargerHeartbeat } from "../services/firebaseSync.js";
import { getKarachiIso, getKarachiTimeString } from "../utils/time.js";
import crypto from "crypto";

export class OCPPServer {
  constructor() {
    // Map of active connections: chargePointId -> { ws, pendingCalls: Map }
    this.connections = new Map();
    this.logs = [];
    this.omMessages = [];
    this.rawListeners = new Set();
  }

  log(msg) {
    const entry = `[${getKarachiTimeString()}] ${msg}`;
    console.log(entry);
    this.logs.unshift(entry);
    if (this.logs.length > 50) this.logs.pop();
  }

  /**
   * Attach WebSocket server to an existing HTTP server
   */
  attach(httpServer) {
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => {
        // Tolerant OCPP subprotocol negotiation
        if (!protocols || protocols.size === 0) {
          // If embedded hardware omitted Sec-WebSocket-Protocol, default to ocpp1.6
          return "ocpp1.6";
        }
        if (protocols.has("ocpp1.6")) return "ocpp1.6";
        if (protocols.has("ocpp1.6j")) return "ocpp1.6j";
        if (protocols.has("ocpp1.5")) return "ocpp1.5";
        return Array.from(protocols)[0] || "ocpp1.6";
      },
    });

    // Handle WebSocket upgrade
    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathname = url.pathname;

      // Extract chargePointId from URL, query params, or hardware headers:
      // Accepts formats:
      // /api/ocpp/version/1.6/:chargePointId
      // /ocpp/:chargePointId
      // /:chargePointId
      // or headers: x-chargebox-id / x-chargepoint-id / chargeboxid
      // or query params: ?chargePointId=...
      const parts = pathname.split("/").filter(Boolean);
      let chargePointId = url.searchParams.get("chargePointId") ||
                          url.searchParams.get("identifier") ||
                          request.headers["x-chargebox-id"] ||
                          request.headers["x-chargepoint-id"] ||
                          request.headers["chargeboxid"] ||
                          "";

      if (!chargePointId && parts.length > 0) {
        const lastPart = parts[parts.length - 1];
        if (lastPart !== "1.6" && lastPart !== "ocpp" && lastPart !== "version") {
          chargePointId = lastPart;
        }
      }
      chargePointId = (chargePointId || "charger1").toLowerCase();

      const proto = request.headers["sec-websocket-protocol"] || "none";
      const agent = request.headers["user-agent"] || "unknown";
      this.log(`Incoming connection request from IP: ${request.socket.remoteAddress} for charger: [${chargePointId}] (URL: ${request.url}, Protocol: ${proto}, Agent: ${agent})`);

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request, chargePointId);
      });
    });

    this.wss.on("connection", (ws, request, chargePointId) => {
      this.handleConnection(ws, chargePointId);
    });

    // Periodic Ping/Pong heartbeat to keep NAT firewalls / Cloudflare alive and detect genuinely dead sockets
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, conn] of this.connections.entries()) {
        const inactiveMs = now - (conn.lastActivity || now);
        // Only terminate if we have seen 2.5 minutes of complete silence (no OCPP messages, heartbeats, or pongs)
        if (inactiveMs > 150000) {
          this.log(`[Keepalive] Terminating unresponsive socket for [${id}] (${Math.round(inactiveMs / 1000)}s of silence)`);
          conn.ws.terminate();
          continue;
        }

        // Only send a low-level WS ping if the socket has been quiet for > 45s,
        // avoiding raw ping frames on sensitive cellular GSM modems that communicate via OCPP Heartbeat
        if (inactiveMs > 45000) {
          try {
            conn.ws.ping();
          } catch (_e) {}
        }
      }
    }, 25000);

    this.log(`OCPP 1.6-J WebSocket Server ready and listening.`);
  }

  handleConnection(ws, chargePointId) {
    this.log(`Charger connected: [${chargePointId}]`);

    const now = Date.now();
    const connEntry = {
      ws,
      lastActivity: now,
      pendingCalls: new Map(),
      connectedAt: getKarachiIso(),
    };

    ws.on("pong", () => {
      connEntry.lastActivity = Date.now();
    });

    ws.on("ping", () => {
      connEntry.lastActivity = Date.now();
      try { ws.pong(); } catch (_e) {}
    });

    this.connections.set(chargePointId, connEntry);
    saveChargerHeartbeat(chargePointId).catch(() => {});

    // If this is the auxiliary O&M channel ([dc_evse]), immediately send type 17 handshake & run discovery sweep
    if (chargePointId === "dc_evse" || chargePointId.includes("om")) {
      setTimeout(() => {
        if (ws.readyState === 1) {
          try {
            ws.ping();
            connEntry.probedOm = true;
            this.probeOmProtocol(chargePointId, ws, { type: 17 }).catch(() => {});
          } catch (_e) {}
        }
      }, 150);
    }

    ws.on("message", async (data) => {
      connEntry.lastActivity = Date.now();
      try {
        const text = data.toString();
        const parsed = JSON.parse(text);
        await this.handleMessage(chargePointId, ws, parsed, text);
      } catch (err) {
        const rawText = data.toString();
        const hexPreview = Buffer.isBuffer(data) ? data.toString("hex").slice(0, 200) : "";
        const preview = rawText.slice(0, 300);
        this.log(`[Raw/Non-JSON message from ${chargePointId}]: ${preview} | HEX: ${hexPreview}`);
        try {
          const { ref, update } = await import("firebase/database");
          const { rtdb } = await import("../config/firebase.js");
          await update(ref(rtdb, `live/${chargePointId}`), {
            lastRawMessage: preview,
            lastRawHex: hexPreview,
            lastRawAt: getKarachiIso(),
          });
        } catch (_e) {}
      }
    });

    ws.on("close", (code, reason) => {
      this.log(`Charger disconnected: [${chargePointId}] (code: ${code}, reason: ${reason || "none"})`);
      // Only mark offline if this socket is still the registered one (avoid race on quick reconnect)
      const conn = this.connections.get(chargePointId);
      if (conn?.ws === ws) {
        if (conn.pendingCalls) {
          for (const [, call] of conn.pendingCalls.entries()) {
            clearTimeout(call.timeout);
            call.reject(new Error(`Charger [${chargePointId}] disconnected while command was in-flight.`));
          }
          conn.pendingCalls.clear();
        }
        this.connections.delete(chargePointId);
        saveChargerOffline(chargePointId);
      }
    });

    ws.on("error", (err) => {
      this.log(`Socket error for [${chargePointId}]: ${err.message}`);
    });
  }

  async handleMessage(chargePointId, ws, message, rawText = "") {
    if (!Array.isArray(message)) {
      const jsonDump = rawText || JSON.stringify(message);
      this.log(`[${chargePointId}] Non-array JSON payload: ${jsonDump}`);
      const entry = {
        direction: "IN",
        chargePointId,
        payload: message,
        raw: jsonDump,
        timestamp: getKarachiIso(),
      };
      this.omMessages.unshift(entry);
      if (this.omMessages.length > 100) this.omMessages.pop();
      for (const listener of this.rawListeners) {
        try { listener(entry); } catch (_e) {}
      }

      // Handle O&M protocol messages from dc_evse (keep separate from charger1)
      if ((chargePointId === "dc_evse" || chargePointId.includes("om")) && message && typeof message === "object") {
        this.handleOmMessage(chargePointId, ws, message).catch((e) => {
          this.log(`[${chargePointId}] O&M handler error: ${e.message}`);
        });
      }

      try {
        const { ref, update } = await import("firebase/database");
        const { rtdb } = await import("../config/firebase.js");
        await update(ref(rtdb, `live/${chargePointId}`), {
          lastRawJson: message,
          lastRawMessage: jsonDump,
          lastRawAt: getKarachiIso(),
        });
      } catch (_e) {}
      return;
    }

    const messageType = message[0];

    // Case 2: CALL from Charger -> Server: [2, "<uniqueId>", "<action>", { ... }]
    if (messageType === 2) {
      const [, uniqueId, action, payload] = message;
      this.log(`<- [${chargePointId}] CALL: ${action}`);

      try {
        const handler = actionHandlers[action];
        let responsePayload = {};

        if (handler) {
          responsePayload = await handler(chargePointId, payload || {});
        } else {
          this.log(`[${chargePointId}] No handler for action: ${action}`);
        }

        // Send CALLRESULT [3, "<uniqueId>", { ... }]
        const response = [3, uniqueId, responsePayload];
        ws.send(JSON.stringify(response));
        this.log(`-> [${chargePointId}] CALLRESULT for: ${action}`);
      } catch (err) {
        this.log(`[${chargePointId}] Error handling ${action}: ${err.message}`);
        // Send CALLERROR [4, "<uniqueId>", "<errorCode>", "<errorDesc>", {}]
        const errorResponse = [4, uniqueId, "InternalError", err.message, {}];
        ws.send(JSON.stringify(errorResponse));
      }
    }

    // Case 3: CALLRESULT from Charger (in response to server command): [3, "<uniqueId>", { ... }]
    else if (messageType === 3) {
      const [, uniqueId, payload] = message;
      const conn = this.connections.get(chargePointId);
      if (conn && conn.pendingCalls.has(uniqueId)) {
        const { resolve, timeout } = conn.pendingCalls.get(uniqueId);
        clearTimeout(timeout);
        conn.pendingCalls.delete(uniqueId);
        resolve(payload);
        this.log(`<- [${chargePointId}] CALLRESULT received for req ${uniqueId}`);
      }
    }

    // Case 4: CALLERROR from Charger: [4, "<uniqueId>", "<errorCode>", "<errorDesc>", { ... }]
    else if (messageType === 4) {
      const [, uniqueId, errorCode, errorDescription] = message;
      const conn = this.connections.get(chargePointId);
      if (conn && conn.pendingCalls.has(uniqueId)) {
        const { reject, timeout } = conn.pendingCalls.get(uniqueId);
        clearTimeout(timeout);
        conn.pendingCalls.delete(uniqueId);
        reject(new Error(`OCPP Error: ${errorCode} - ${errorDescription}`));
        this.log(`<- [${chargePointId}] CALLERROR received: ${errorCode} - ${errorDescription}`);
      }
    }
  }

  /**
   * Send an outgoing OCPP command to a connected charger with retry logic and response confirmation
   */
  async sendCall(chargePointId, action, payload = {}, maxRetries = 2, attemptTimeoutMs = 8000) {
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const conn = this.connections.get(chargePointId.toLowerCase());
      if (!conn || conn.ws.readyState !== 1) {
        throw new Error(`Charger [${chargePointId}] is not currently connected.`);
      }

      if (attempt > 0) {
        this.log(`⚠️ [${chargePointId}] Retrying ${action} (attempt ${attempt + 1}/${maxRetries + 1})...`);
        await new Promise((r) => setTimeout(r, 1200));
      }

      const uniqueId = crypto.randomUUID();
      const message = [2, uniqueId, action, payload];

      try {
        const response = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (conn.pendingCalls.has(uniqueId)) {
              conn.pendingCalls.delete(uniqueId);
              reject(new Error(`Timeout (${attemptTimeoutMs / 1000}s) waiting for response from [${chargePointId}] for action: ${action}`));
            }
          }, attemptTimeoutMs);

          conn.pendingCalls.set(uniqueId, {
            resolve: (res) => {
              clearTimeout(timeout);
              resolve(res);
            },
            reject: (err) => {
              clearTimeout(timeout);
              reject(err);
            },
            timeout,
          });

          this.log(`-> [${chargePointId}] Sending CALL (${attempt + 1}/${maxRetries + 1}): ${action}`);
          conn.ws.send(JSON.stringify(message));
        });

        this.log(`<- [${chargePointId}] Confirmed ${action} response:`, JSON.stringify(response));
        return response;
      } catch (err) {
        lastError = err;
        this.log(`❌ [${chargePointId}] Attempt ${attempt + 1} failed for ${action}: ${err.message}`);
      }
    }

    throw new Error(`Station did not respond to ${action} after ${maxRetries + 1} attempts: ${lastError?.message || 'No response'}`);
  }

  // --- Convenience Helper Methods ---

  /**
   * Remotely unlock the charging connector (cable)
   */
  async unlockConnector(chargePointId, connectorId = 1) {
    this.log(`Unlocking connector ${connectorId} on [${chargePointId}]...`);
    const res = await this.sendCall(chargePointId, "UnlockConnector", {
      connectorId: Number(connectorId),
    });
    return res;
  }

  /**
   * Remotely stop an active charging transaction
   */
  async remoteStopTransaction(chargePointId, transactionId) {
    this.log(`Remote stopping transaction ${transactionId} on [${chargePointId}]...`);
    return await this.sendCall(chargePointId, "RemoteStopTransaction", {
      transactionId: Number(transactionId),
    });
  }

  /**
   * Remotely start a charging transaction
   */
  async remoteStartTransaction(chargePointId, connectorId = 1, idTag = "AppUser") {
    this.log(`Remote starting charge on connector ${connectorId} on [${chargePointId}]...`);
    return await this.sendCall(chargePointId, "RemoteStartTransaction", {
      connectorId: Number(connectorId),
      idTag,
    });
  }

  /**
   * Soft or hard reboot the charger
   */
  async reset(chargePointId, type = "Soft") {
    this.log(`Rebooting (${type} reset) charger [${chargePointId}]...`);
    return await this.sendCall(chargePointId, "Reset", { type });
  }

  /**
   * Change charger configuration parameter
   */
  async changeConfiguration(chargePointId, key, value) {
    return await this.sendCall(chargePointId, "ChangeConfiguration", {
      key,
      value: String(value),
    });
  }

  /**
   * Request charger to immediately send a specific message (e.g. MeterValues, StatusNotification)
   */
  async triggerMessage(chargePointId, requestedMessage = "MeterValues", connectorId = 1) {
    this.log(`Triggering message [${requestedMessage}] on connector ${connectorId} on [${chargePointId}]...`);
    return await this.sendCall(chargePointId, "TriggerMessage", {
      requestedMessage,
      connectorId: Number(connectorId),
    });
  }

  /**
   * Get charger internal configuration keys
   */
  async getConfiguration(chargePointId, keys = []) {
    if (chargePointId === "dc_evse" && this.lastOmConfigs && this.lastOmConfigs.length > 0) {
      return { configurationKey: this.lastOmConfigs, unknownKey: [], source: "om_type_15" };
    }
    const payload = keys.length ? { key: keys } : {};
    return await this.sendCall(chargePointId, "GetConfiguration", payload);
  }

  /**
   * Poll valid O&M telemetry commands (16=Firmware, 12=GunStatus, 14=Configs) on dc_evse
   */
  async probeOmProtocol(chargePointId, ws, _initialMsg) {
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 16 }));
      }
      await new Promise((r) => setTimeout(r, 800));
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 12 }));
      }
      await new Promise((r) => setTimeout(r, 800));
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 14 }));
      }
      this.log(`-> [${chargePointId}] Requested O&M telemetry (types 16, 12, 14)`);
    } catch (err) {
      this.log(`[${chargePointId}] O&M poll error: ${err.message}`);
    }
  }

  /**
   * Process incoming O&M JSON messages (type 1, 13, 15, 17) for dc_evse only (no bridging to charger1)
   */
  async handleOmMessage(chargePointId, ws, message) {
    const { ref, update } = await import("firebase/database");
    const { rtdb } = await import("../config/firebase.js");
    const { saveChargerHeartbeat } = await import("../services/firebaseSync.js");

    await saveChargerHeartbeat(chargePointId);

    if (ws.readyState === 1 && (message.type === 1 || message.type === 13)) {
      ws.send(JSON.stringify({ type: 16 }));
      setTimeout(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 14 }));
      }, 600);
    }

    if (message.type === 15 && message.configs) {
      let parsedConfigs = [];
      try {
        parsedConfigs = typeof message.configs === "string" ? JSON.parse(message.configs) : message.configs;
      } catch (_e) {}
      if (Array.isArray(parsedConfigs) && parsedConfigs.length > 0) {
        this.lastOmConfigs = parsedConfigs;
        await update(ref(rtdb, `live/${chargePointId}`), {
          configurationList: parsedConfigs,
          configurationUpdatedAt: getKarachiIso(),
        });
      }
    }
  }

  /**
   * Send raw JSON object/string to an O&M WebSocket (like dc_evse) and collect replies
   */
  async sendRawJson(chargePointId = "dc_evse", payload = {}, waitMs = 2000) {
    const conn = this.connections.get(chargePointId);
    if (!conn || conn.ws.readyState !== 1) {
      throw new Error(`Charger [${chargePointId}] is not currently connected.`);
    }
    const replies = [];
    const listener = (entry) => {
      if (entry.chargePointId === chargePointId) {
        replies.push(entry);
      }
    };
    this.rawListeners.add(listener);
    const jsonStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.log(`-> [${chargePointId}] Sent O&M JSON: ${jsonStr}`);
    this.omMessages.unshift({
      direction: "OUT",
      chargePointId,
      payload,
      raw: jsonStr,
      timestamp: getKarachiIso(),
    });
    if (this.omMessages.length > 100) this.omMessages.pop();
    conn.ws.send(jsonStr);

    await new Promise((r) => setTimeout(r, waitMs));
    this.rawListeners.delete(listener);
    return {
      sent: payload,
      replies,
      socketAlive: conn.ws.readyState === 1,
    };
  }

  /**
   * Get list of currently connected chargers
   */
  getConnectedChargers() {
    const list = [];
    for (const [id, conn] of this.connections.entries()) {
      if (conn.ws && conn.ws.readyState === 1) {
        list.push({
          chargePointId: id,
          connectedAt: conn.connectedAt,
          readyState: "Connected",
        });
      }
    }
    return list;
  }
}

export const ocppServer = new OCPPServer();
