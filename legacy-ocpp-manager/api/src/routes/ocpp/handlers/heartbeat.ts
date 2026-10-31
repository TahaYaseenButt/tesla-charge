import z from "zod";
import type { ActionHandler } from "./ActionHandler";
import { HeartbeatRequestSchema, HeartbeatResponseSchema } from "../types";
import type { WSCustomContext } from "../WSCustomContext";

export const heartbeat: ActionHandler = {
  handleRequest: async (
    payload: unknown,
    wsCtx: WSCustomContext
  ): Promise<z.infer<typeof HeartbeatResponseSchema>> => {
    HeartbeatRequestSchema.parse(payload);

    const currentTime = new Date().toISOString();
    const charger = wsCtx.get("charger");

    await charger.update({
      lastHeartbeat: currentTime,
    });

    return { currentTime };
  },
} as const;
