import type { Selectable } from "kysely";
import { generateBaseModel } from "./base";
import type { DB } from "../db/DBTypes";
import { ocppWebsocketManager } from "../../routes/ocpp/OCPPWebsocketManager";
import {
  RemoteStopTransactionResponseSchema,
  ResetRequestSchema,
  ResetResponseSchema,
  type RemoteStopTransactionRequest,
} from "../../routes/ocpp/types";
import type { z } from "zod";
import { Transaction } from "./Transaction";

export interface Charger extends Selectable<DB["charger"]> {}
export class Charger extends generateBaseModel("charger", "id", "updatedAt") {
  async remoteStopTransaction(transactionId: number) {
    const message: RemoteStopTransactionRequest = {
      transactionId: transactionId,
    };

    const transaction = await Transaction.findOne({
      eb: (eb) => eb("id", "=", transactionId),
    });

    const res = await ocppWebsocketManager.sendCall({
      action: "RemoteStopTransaction",
      message,
      shortcode: this.shortcode,
      responseSchema: RemoteStopTransactionResponseSchema,
    });

    if (res[2].status === "Accepted") {
      await transaction?.update({
        stopTime: new Date(),
        reason: "RemoteStopTransaction",
      });
    }

    return res;
  }

  async reset(type: "Hard" | "Soft") {
    const message: z.infer<typeof ResetRequestSchema> = {
      type,
    };
    return await ocppWebsocketManager.sendCall({
      shortcode: this.shortcode,
      action: "Reset",
      message,
      responseSchema: ResetResponseSchema,
    });
  }
}
