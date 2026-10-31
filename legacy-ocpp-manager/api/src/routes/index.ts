import { Hono } from "hono";
import type { NodeWebSocket } from "@hono/node-ws";
import { ocpp } from "./ocpp";
import { log } from "./log";
import { setting } from "./setting";
import { charger } from "./charger";
import { chargeAuthorization } from "./chargeAuthorization";
import { connector } from "./connector";
import { rfidTag } from "./rfid-tag/+index";
import { transaction } from "./transaction";

export function api(nodeWs: NodeWebSocket) {
  return new Hono()
    .route("/ocpp", ocpp(nodeWs))
    .route("/log", log)
    .route("/setting", setting)
    .route("/charger", charger)
    .route("/charge-authorization", chargeAuthorization)
    .route("/connector", connector)
    .route("/rfid-tag", rfidTag)
    .route("/transaction", transaction);
}
