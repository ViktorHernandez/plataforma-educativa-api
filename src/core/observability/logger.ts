import { pino, type Logger, type LoggerOptions } from "pino";
import type { AppConfig } from "../../config/env.js";

export const redactedPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-csrf-token']",
  "req.headers['x-device-id']",
  "res.headers['set-cookie']",
  "*.password",
  "*.newPassword",
  "*.currentPassword",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.secret",
  "*.recoveryCode",
  "*.authorization",
];

function prettyTransportAvailable(): boolean {
  try {
    import.meta.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export function buildLoggerOptions(config: Pick<AppConfig, "LOG_LEVEL" | "LOG_PRETTY" | "APP_ENV">): LoggerOptions {
  const options: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { service: "plataforma-educativa-api", env: config.APP_ENV },
    redact: { paths: redactedPaths, censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  if (config.LOG_PRETTY && prettyTransportAvailable()) {
    options.transport = { target: "pino-pretty", options: { singleLine: true, translateTime: "SYS:standard" } };
  }
  return options;
}

export function createLogger(config: Pick<AppConfig, "LOG_LEVEL" | "LOG_PRETTY" | "APP_ENV">): Logger {
  return pino(buildLoggerOptions(config));
}

export type { Logger };
