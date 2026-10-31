import { z } from "zod";

export const createCallResultSchema = <T extends z.ZodTypeAny = z.ZodAny>(
  payloadSchema: T = z.any() as unknown as T
) => {
  return z.tuple([
    z.custom<number>((val) => val === 3),
    z.string(),
    payloadSchema,
  ]);
};

export type CallResult<T = any> = [3, string, T];

export const CallResultSchema = createCallResultSchema();
