export const LocationEnum = {
  Cable: "Cable",
  EV: "EV",
  Inlet: "Inlet",
  Outlet: "Outlet",
  Body: "Body",
} as const;

export type LocationEnum = (typeof LocationEnum)[keyof typeof LocationEnum];
