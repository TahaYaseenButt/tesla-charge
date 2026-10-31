import z from "zod";
import { Transaction } from "../../../lib/models/Transaction";
import {
  StopTransactionRequestSchema,
  StopTransactionResponseSchema,
} from "../types";
import type { ActionHandler } from "./ActionHandler";
import type { WSCustomContext } from "../WSCustomContext";
import { ChargeAuthorization } from "../../../lib/models/ChargeAuthorization";

export const stopTransaction: ActionHandler = {
  handleRequest: async (
    payload: unknown,
    _wsCtx: WSCustomContext
  ): Promise<z.infer<typeof StopTransactionResponseSchema>> => {
    const parsedData = StopTransactionRequestSchema.parse(payload);

    const { meterStop, timestamp, transactionId, reason, idTag } = parsedData;

    const transaction = await Transaction.findOne({
      eb: (eb) => eb("id", "=", transactionId),
    });

    if (!transaction) {
      return {
        idTagInfo: {
          status: "Accepted",
        },
      };
    }

    await transaction.update({
      meterStop,
      stopTime: new Date(timestamp).toISOString(),
      status: reason ? "Completed" : "Failed",
      reason: reason || "Local",
    });

    let idTagInfo:
      | z.infer<typeof StopTransactionResponseSchema>["idTagInfo"]
      | undefined = undefined;
    if (idTag) {
      const authRecord = await ChargeAuthorization.searchValidByIdTag({
        idTag,
        chargerId: transaction.chargeAuthorizationId || 0,
      });

      idTagInfo = !authRecord
        ? { status: "Blocked" }
        : authRecord.expiryDate && new Date(authRecord.expiryDate) < new Date()
        ? { status: "Expired" }
        : {
            status: "Accepted",
            expiryDate: authRecord.expiryDate
              ? new Date(authRecord.expiryDate).toISOString()
              : undefined,
          };
    }

    return {
      idTagInfo,
    };
  },
} as const;
