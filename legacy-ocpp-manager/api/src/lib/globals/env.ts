import dotenv from "dotenv";
dotenv.config();

type EnvVariables = {
  DATABASE_URL: string;
};

export const env = {
  get<K extends keyof EnvVariables>(
    key: K,
    fallback?: EnvVariables[K]
  ): EnvVariables[K] {
    const value = process.env[key as string];

    if (!value) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing environment variable: ${key}`);
    }

    return value as EnvVariables[K];
  },
} as const;
