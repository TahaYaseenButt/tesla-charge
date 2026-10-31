export const AuthorizationStatusEnum = {
  Accepted: "Accepted",
  Blocked: "Blocked",
  Expired: "Expired",
  Invalid: "Invalid",
  ConcurrentTx: "ConcurrentTx",
} as const;

export type AuthorizationStatusEnum =
  (typeof AuthorizationStatusEnum)[keyof typeof AuthorizationStatusEnum];
