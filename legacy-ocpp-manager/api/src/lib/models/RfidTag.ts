import type { Selectable } from "kysely";
import { generateBaseModel } from "./base";
import type { DB } from "../db/DBTypes";
import { db } from "../db/db";
import { Transaction } from "./Transaction";

export interface RfidTag extends Selectable<DB["rfidTag"]> {}
export class RfidTag extends generateBaseModel("rfidTag", "id", "updatedAt") {
  async getFullDetail() {
    const lastTransactionRaw = await db
      .selectFrom("transaction as t")
      .innerJoin(
        "chargeAuthorization as ca",
        "ca.id",
        "t.chargeAuthorizationId"
      )
      .where("ca.rfidTagId", "=", this.id)
      .selectAll("t")
      .orderBy("t.createdAt desc")
      .executeTakeFirst();

    const lastTransaction = lastTransactionRaw
      ? new Transaction(lastTransactionRaw).serialize()
      : null;

    return {
      ...this.serialize(),
      lastTransaction,
    };
  }
}
