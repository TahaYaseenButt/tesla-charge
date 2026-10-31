export const UnlockStatusEnum = {
  Unlocked: "Unlocked",
  UnlockFailed: "UnlockFailed",
  NotSupported: "NotSupported",
} as const;

export type UnlockStatusEnum =
  (typeof UnlockStatusEnum)[keyof typeof UnlockStatusEnum];
