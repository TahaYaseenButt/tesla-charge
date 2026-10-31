import type { MiddlewareHandler } from "hono";
import { logger } from "../lib/globals/logger";
import { getConnInfo } from "@hono/node-server/conninfo";

export const customLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.url;

  const connInfo = getConnInfo(c);
  const clientIp = connInfo.remote.address;

  logger.http(`--> ${method} ${path} [IP: ${clientIp}]`);

  try {
    await next();
  } catch (err) {
    logger.error(
      `[ERROR] ${method} ${path} [IP: ${clientIp}] - ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    throw err;
  }

  const statusCode = c.res.status;
  const elapsed = Date.now() - start;

  logger.http(
    `<-- ${method} ${path} [IP: ${clientIp}] ${statusCode} ${elapsed}ms`
  );
};
