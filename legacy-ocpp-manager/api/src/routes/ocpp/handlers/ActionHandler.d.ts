import type { WSCustomContext } from "../WSContext";

export type ActionHandler = {
  handleRequest: (
    payload: unknown,
    wsCtx: WSCustomContext
  ) => Promise<object | string>;
};
