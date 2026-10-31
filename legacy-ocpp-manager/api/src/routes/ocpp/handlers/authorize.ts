import z from "zod";
import { ChargeAuthorization } from "../../../lib/models/ChargeAuthorization";
import { AuthorizeRequestSchema, AuthorizeResponseSchema } from "../types";
import type { ActionHandler } from "./ActionHandler";
import type { WSCustomContext } from "../WSCustomContext";

export const authorize: ActionHandler = {
  handleRequest: async (
    payload: unknown,
    wsCtx: WSCustomContext
  ): Promise<z.infer<typeof AuthorizeResponseSchema>> => {
    let parsedData: z.infer<typeof AuthorizeRequestSchema>;

    parsedData = AuthorizeRequestSchema.parse(payload);

    const charger = wsCtx.get("charger");

    const authRecord = await ChargeAuthorization.searchValidByIdTag({
      idTag: parsedData.idTag,
      chargerId: charger.id,
    });

    const idTagInfo: z.infer<typeof AuthorizeResponseSchema>["idTagInfo"] =
      !authRecord
        ? { status: "Blocked" }
        : authRecord.expiryDate && new Date(authRecord.expiryDate) < new Date()
        ? { status: "Expired" }
        : {
            status: "Accepted",
            expiryDate: authRecord.expiryDate
              ? new Date(authRecord.expiryDate).toISOString()
              : undefined,
          };

    return { idTagInfo };
  },
} as const;
