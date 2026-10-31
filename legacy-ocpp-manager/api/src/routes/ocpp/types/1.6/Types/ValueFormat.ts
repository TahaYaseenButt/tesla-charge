export const ValueFormatEnum = {
  Raw: "Raw",
  SignedData: "SignedData",
} as const;

export type ValueFormatEnum =
  (typeof ValueFormatEnum)[keyof typeof ValueFormatEnum];
