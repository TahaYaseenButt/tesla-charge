import { WebSocketServer } from "ws";
import { actionHandlers } from "./actionHandlers.js";
import crypto from "crypto";

export class OCPPServer {
  constructor() {
    // Map of active connections: chargePointId -> { ws, pendingCalls: Map }
    this.connections = new Map();
    this.logs = [];
  }

  log(msg) {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
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
        // Strict OCPP 1.6-J standard subprotocol negotiation
        if (protocols.has("ocpp1.6")) return "ocpp1.6";
        if (protocols.has("ocpp1.5")) return "ocpp1.5";
        return Array.from(protocols)[0] || false;
      },
    });

    // Handle WebSocket upgrade
    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathname = url.pathname;

      // Extract chargePointId from URL:
      // Accepts formats:
      // /api/ocpp/version/1.6/:chargePointId
      // /ocpp/:chargePointId
      // /:chargePointId
      const parts = pathname.split("/").filter(Boolean);
      const chargePointId = (parts[parts.length - 1] || "unknown").toLowerCase();

      this.log(`Incoming connection request from IP: ${request.socket.remoteAddress} for charger: ${chargePointId}`);

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request, chargePointId);
      });
    });

    this.wss.on("connection", (ws, request, chargePointId) => {
      this.handleConnection(ws, chargePointId);
    });

    this.log(`OCPP 1.6-J WebSocket Server ready and listening.`);
  }

  handleConnection(ws, chargePointId) {
    this.log(`Charger connected: [${chargePointId}]`);

    this.connections.set(chargePointId, {
      ws,
      pendingCalls: new Map(),
      connectedAt: new Date().toISOString(),
    });

    ws.on("message", async (data) => {
      try {
        const text = data.toString();
        const parsed = JSON.parse(text);
        await this.handleMessage(chargePointId, ws, parsed);
      } catch (err) {
        this.log(`[Error parsing message from ${chargePointId}]: ${err.message}`);
      }
    });

    ws.on("close", (code, reason) => {
      this.log(`Charger disconnected: [${chargePointId}] (code: ${code}, reason: ${reason || "none"})`);
      this.connections.delete(chargePointId);
    });

    ws.on("error", (err) => {
      this.log(`Socket error for [${chargePointId}]: ${err.message}`);
    });
  }

  async handleMessage(chargePointId, ws, message) {
    if (!Array.isArray(message)) {
      this.log(`[${chargePointId}] Invalid message format: not an array`);
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
        const { resolve } = conn.pendingCalls.get(uniqueId);
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
        const { reject } = conn.pendingCalls.get(uniqueId);
        conn.pendingCalls.delete(uniqueId);
        reject(new Error(`OCPP Error: ${errorCode} - ${errorDescription}`));
        this.log(`<- [${chargePointId}] CALLERROR received: ${errorCode} - ${errorDescription}`);
      }
    }
  }

  /**
   * Send an outgoing OCPP command to a connected charger
   */
  async sendCall(chargePointId, action, payload = {}) {
    const conn = this.connections.get(chargePointId.toLowerCase());
    if (!conn || conn.ws.readyState !== 1) {
      throw new Error(`Charger [${chargePointId}] is not currently connected.`);
    }

    const uniqueId = crypto.randomUUID();
    const message = [2, uniqueId, action, payload];

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (conn.pendingCalls.has(uniqueId)) {
          conn.pendingCalls.delete(uniqueId);
          reject(new Error(`Timeout waiting for response from [${chargePointId}] for action: ${action}`));
        }
      }, 15000); // 15 seconds timeout

      conn.pendingCalls.set(uniqueId, {
        resolve: (res) => {
          clearTimeout(timeout);
          resolve(res);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.log(`-> [${chargePointId}] Sending CALL: ${action}`);
      conn.ws.send(JSON.stringify(message));
    });
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
    const payload = keys.length ? { key: keys } : {};
    return await this.sendCall(chargePointId, "GetConfiguration", payload);
  }

  /**
   * Get list of currently connected chargers
   */
  getConnectedChargers() {
    const list = [];
    for (const [id, conn] of this.connections.entries()) {
      list.push({
        chargePointId: id,
        connectedAt: conn.connectedAt,
        readyState: conn.ws.readyState === 1 ? "Connected" : "Disconnected",
      });
    }
    return list;
  }
}

export const ocppServer = new OCPPServer();
