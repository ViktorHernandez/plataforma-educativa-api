import { Redis, type RedisOptions } from "ioredis";
import type { Logger } from "pino";

export type RedisClient = Redis;

export interface RedisSettings {
  url: string;
  protocol?: 2 | 3;
  commandTimeoutMs?: number;
}

export function redisOptions(settings: RedisSettings, overrides: RedisOptions = {}): RedisOptions {
  return {
    lazyConnect: false,
    enableAutoPipelining: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    commandTimeout: settings.commandTimeoutMs ?? 2000,
    protocol: settings.protocol ?? 2,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    ...overrides,
  };
}

export function createRedis(settings: RedisSettings, logger: Logger, overrides: RedisOptions = {}): Redis {
  const client = new Redis(settings.url, redisOptions(settings, overrides));
  client.on("error", (error: Error) => {
    logger.warn({ err: { message: error.message } }, "redis connection error");
  });
  return client;
}

export function createBlockingRedis(settings: RedisSettings, logger: Logger): Redis {
  return createRedis(settings, logger, { maxRetriesPerRequest: null, commandTimeout: undefined, enableAutoPipelining: false });
}

export class RedisKeys {
  constructor(private readonly prefix: string) {}

  key(...parts: string[]): string {
    return `${this.prefix}${parts.join(":")}`;
  }

  get rawPrefix(): string {
    return this.prefix;
  }
}

export function isRedisReady(client: Redis): boolean {
  return client.status === "ready";
}
