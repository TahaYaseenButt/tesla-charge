import { createLogger, transports, format } from "winston";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import type { TransformableInfo } from "logform";

export const logDir = path.join(process.cwd(), "logs");

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logFile = path.join(
  logDir,
  `${new Date().toISOString().split("T")[0]}.log`
);

function formatMeta(meta: unknown): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  return ` | ${JSON.stringify(meta, null, 2)}`;
}

// Level colors for console output
const levelColors: Record<string, (text: string) => string> = {
  error: (text: string) => chalk.bold.red(text),
  warn: (text: string) => chalk.hex("#FFA500")(text), // Orange
  info: (text: string) => chalk.cyan(text),
  debug: (text: string) => chalk.green(text),
  silly: (text: string) => chalk.magenta(text),
};

export const logger = createLogger({
  level: "debug",
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.printf((info: TransformableInfo) => {
      const { timestamp, level, message, ...meta } = info;
      return `${timestamp} [${level.toUpperCase()}] ${message}${formatMeta(
        meta
      )}`;
    })
  ),
  transports: [
    // Console Transport: Colorful and formatted for readability
    new transports.Console({
      format: format.combine(
        format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        format.printf((info: TransformableInfo) => {
          const { timestamp, level, message, ...meta } = info;
          const colorizedLevel = levelColors[level]
            ? levelColors[level](level.toUpperCase())
            : level.toUpperCase();

          return `${chalk.dim(timestamp)} [${colorizedLevel}] ${chalk.white(
            message
          )}${chalk.gray(formatMeta(meta))}`;
        })
      ),
    }),

    // File Transport: Plain text and easy to parse
    new transports.File({
      filename: logFile,
      format: format.combine(
        format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        format.printf((info: TransformableInfo) => {
          const { timestamp, level, message, ...meta } = info;
          return `${timestamp} [${level.toUpperCase()}] ${message}${formatMeta(
            meta
          )}`;
        })
      ),
      maxFiles: 14,
    }),
  ],
});
