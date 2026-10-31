import type { Selectable } from "kysely";
import { generateBaseModel } from "./base";
import type { DB } from "../db/DBTypes";
import type { MeterValuesRequest } from "../../routes/ocpp/types";

export type CustomTelemetry = Selectable<DB["telemetry"]> & {
  meterValue: {
    raw: MeterValuesRequest["meterValue"];
  };
};
export interface Telemetry extends CustomTelemetry {}
export class Telemetry extends generateBaseModel("telemetry", "id") {}
