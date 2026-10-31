import type { Context } from "hono";
import type WebSocket from "ws";
import type { CloseEvent } from "ws";

export interface WebSocketMessageEvent {
  data: string | Buffer;
}

export interface WebSocketHandlerReturn {
  onMessage?: (e: WebSocketMessageEvent, w: WebSocket) => Promise<void> | void;
  onClose?: (e: CloseEvent) => void;
}

export type UpgradeWebSocket = (
  fn: (c: Context) => WebSocketHandlerReturn
) => (c: Context) => Response;
