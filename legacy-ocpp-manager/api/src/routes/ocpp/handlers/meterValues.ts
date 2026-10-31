import z from "zod";

import { MeterValuesRequestSchema, MeterValuesResponseSchema } from "../types";
import type { ActionHandler } from "./ActionHandler";
import type { WSCustomContext } from "../WSCustomContext";
import { Telemetry } from "../../../lib/models/Telemetry";
import { Transaction } from "../../../lib/models/Transaction";
import { Connector } from "../../../lib/models/Connector";

export const meterValues: ActionHandler = {
  handleRequest: async (
    payload: unknown,
    wsCtx: WSCustomContext
  ): Promise<z.infer<typeof MeterValuesResponseSchema>> => {
    const parsedData = MeterValuesRequestSchema.parse(payload);

    const charger = wsCtx.get("charger");

    const { connectorId, meterValue, transactionId } = parsedData;

    let [transaction, connector] = await Promise.all([
      Transaction.findOne({
        eb: (eb) => eb("id", "=", transactionId || -1),
      }),
      Connector.findOne({
        eb: (eb) =>
          eb.and([
            eb("connector.connectorId", "=", connectorId),
            eb("chargerId", "=", charger.id),
          ]),
      }),
    ]);

    if (!connector) {
      connector = await Connector.insert({
        chargerId: charger.id,
        connectorId,
      });
    }

    await Telemetry.insert({
      connectorId: connector?.id,
      transactionId: transaction?.id || null,
      meterValue: {
        raw: meterValue,
      },
    });

    return {};
  },
} as const;
