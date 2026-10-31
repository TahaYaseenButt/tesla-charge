import { Hono } from "hono";
import type { NodeWebSocket } from "@hono/node-ws";
import { logger } from "../../lib/globals/logger";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ocppWebsocketManager } from "./OCPPWebsocketManager";

export const ocpp = ({ upgradeWebSocket }: NodeWebSocket) => {
  const app = new Hono().get(
    "/version/1.6/:shortcode",
    upgradeWebSocket(async (c) => {
      const clientIp = getConnInfo(c).remote.address;
      const shortcode = (c.req.param("shortcode") || "").trim().toLowerCase();

      if (!shortcode) {
        logger.error("No shortcode provided.");
        throw new Error("Shortcode is required");
      }

      logger.http("WebSocket connection initiated", {
        ip: clientIp,
        shortcode,
      });

      return {
        async onOpen(_e: Event, ws) {
          try {
            await ocppWebsocketManager.setConnection(shortcode, ws);
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Unknown error occurred";
            logger.error("Error during onOpen", { error: errorMessage });
            ws.close(1011, "Failed to initialize context");
          }
        },

        async onMessage(e: MessageEvent) {
          ocppWebsocketManager.handleIncomingMessage(shortcode, e.data);
        },

        onClose(_e) {
          ocppWebsocketManager.cleanInactiveConnections();
          logger.http("WebSocket connection closed", {
            ip: clientIp,
            shortcode,
          });
        },
      };
    })
  );

  return app;
};
