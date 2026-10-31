import type { Selectable } from "kysely";
import { generateBaseModel } from "./base";
import type { DB } from "../db/DBTypes";
import { ocppWebsocketManager } from "../../routes/ocpp/OCPPWebsocketManager";
import {
  ChangeConfigurationResponseSchema,
  type ChangeConfigurationRequest,
} from "../../routes/ocpp/types";
import { logger } from "../globals/logger";

export interface Setting extends Selectable<DB["setting"]> {}
export class Setting extends generateBaseModel("setting", "id") {
  static async applyCurrentViaChangeConfiguration(shortcode?: string) {
    const setting = await Setting.findOneOrThrow();

    const configurations: ChangeConfigurationRequest[] = [
      {
        key: "HeartbeatInterval",
        value: setting.heartbeatInterval.toString(),
      },
      {
        key: "MeterValueSampleInterval",
        value: setting.meterValueSampleInterval.toString(),
      },
      {
        key: "ClockAlignedDataInterval",
        value: setting.clockAlignedDataInterval.toString(),
      },
    ];

    const keys = shortcode
      ? [shortcode]
      : Array.from(ocppWebsocketManager.getActiveConnections().keys());

    await Promise.all(
      keys.map((key) => {
        return Promise.all(
          configurations.map((config) =>
            ocppWebsocketManager.sendCall({
              action: "ChangeConfiguration",
              shortcode: key,
              message: config,
              responseSchema: ChangeConfigurationResponseSchema,
            })
          )
        ).catch((e) => {
          logger.error(`Error applying configuration to ${key}`, e);
        });
      })
    );
  }
}
