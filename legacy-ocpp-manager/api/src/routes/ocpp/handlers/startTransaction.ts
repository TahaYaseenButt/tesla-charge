import z from "zod";
import { ChargeAuthorization } from "../../../lib/models/ChargeAuthorization";
import { Transaction } from "../../../lib/models/Transaction";
import { Connector } from "../../../lib/models/Connector";
import {
  StartTransactionRequestSchema,
  StartTransactionResponseSchema,
} from "../types";
import type { ActionHandler } from "./ActionHandler";
import type { WSCustomContext } from "../WSCustomContext";

export const startTransaction: ActionHandler = {
  handleRequest: async (
    payload: unknown,
    wsCtx: WSCustomContext
  ): Promise<z.infer<typeof StartTransactionResponseSchema>> => {
    const parsedData = StartTransactionRequestSchema.parse(payload);

    const { connectorId, idTag, meterStart, timestamp } = parsedData;

    const charger = wsCtx.get("charger");

    const connector = await Connector.findOne({
      eb: (eb) =>
        eb.and([
          eb("chargerId", "=", charger.id),
          eb("connectorId", "=", connectorId),
        ]),
    });

    if (!connector) {
      throw new Error(
        `Connector ${connectorId} not found for charger ${charger.id}`
      );
    }

    const authRecord = await ChargeAuthorization.searchValidByIdTag({
      idTag,
      chargerId: charger.id,
    });

    const idTagInfo: z.infer<
      typeof StartTransactionResponseSchema
    >["idTagInfo"] = !authRecord
      ? { status: "Blocked" }
      : authRecord.expiryDate && new Date(authRecord.expiryDate) < new Date()
      ? { status: "Expired" }
      : {
          status: "Accepted",
          expiryDate: authRecord.expiryDate
            ? new Date(authRecord.expiryDate).toISOString()
            : undefined,
        };

    if (idTagInfo.status !== "Accepted") {
      return {
        idTagInfo,
        transactionId: -1,
      };
    }

    const transaction = await Transaction.insert({
      chargeAuthorizationId: authRecord?.id,
      connectorId: connector.id,
      meterStart,
      startTime: new Date(timestamp).toISOString(),
      status: "Active",
    });

    return {
      idTagInfo,
      transactionId: transaction.id,
    };
  },
} as const;
