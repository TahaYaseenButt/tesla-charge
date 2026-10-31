export const RemoteStartStopStatusEnum = {
  Accepted: "Accepted",
  Rejected: "Rejected",
} as const;

export type RemoteStartStopStatusEnum =
  (typeof RemoteStartStopStatusEnum)[keyof typeof RemoteStartStopStatusEnum];
