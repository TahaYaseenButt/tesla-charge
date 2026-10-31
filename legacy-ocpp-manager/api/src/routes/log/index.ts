import { Hono } from "hono";
import { stream } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { LogsModel } from "../../lib/models/LogsModel";

export const log = new Hono().get(
  "/stream",
  zValidator(
    "query",
    z.object({
      maxLines: z.coerce.number().optional(),
    })
  ),
  async (c) => {
    const { maxLines } = c.req.valid("query");
    c.header("Content-Encoding", "Identity");

    return stream(c, async (writer) => {
      const logsStream = await LogsModel.streamLogs(maxLines || undefined);
      const reader = logsStream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    });
  }
);
