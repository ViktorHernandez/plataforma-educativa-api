import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { z } from "zod";
import type { Database } from "../../core/database/prisma.js";
import { ErrorCode, badRequest, notFound } from "../../core/http/errors.js";
import type { RedisKeys } from "../../core/redis/redis.js";

export const platformSettingSchemas = {
  "registration.enabled": z.boolean(),
  "registration.allowedEmailDomains": z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(200),
  "messaging.studentDirectMessages": z.boolean(),
  "enrollment.requireInstitutionMembershipForPublicCourses": z.boolean(),
} as const;

export type PlatformSettingKey = keyof typeof platformSettingSchemas;
export type PlatformSettingValue<K extends PlatformSettingKey> = z.infer<(typeof platformSettingSchemas)[K]>;

const CACHE_TTL_SECONDS = 60;

export class PlatformSettingsService {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly keys: RedisKeys,
    private readonly logger: Logger,
    private readonly defaults: { [K in PlatformSettingKey]: PlatformSettingValue<K> },
  ) {}

  static isKnownKey(key: string): key is PlatformSettingKey {
    return Object.prototype.hasOwnProperty.call(platformSettingSchemas, key);
  }

  async get<K extends PlatformSettingKey>(key: K): Promise<PlatformSettingValue<K>> {
    const cacheKey = this.keys.key("settings", key);
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) return JSON.parse(cached) as PlatformSettingValue<K>;
    } catch (error) {
      this.logger.warn({ err: error }, "settings cache read failed");
    }
    const stored = await this.db.platformSetting.findUnique({ where: { key } });
    const parsed = stored ? platformSettingSchemas[key].safeParse(stored.value) : null;
    const value = (parsed?.success ? parsed.data : this.defaults[key]) as PlatformSettingValue<K>;
    try {
      await this.redis.set(cacheKey, JSON.stringify(value), "EX", CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: error }, "settings cache write failed");
    }
    return value;
  }

  async list(): Promise<Array<{ key: PlatformSettingKey; value: unknown; updatedAt: Date | null }>> {
    const stored = await this.db.platformSetting.findMany();
    const byKey = new Map(stored.map((item) => [item.key, item]));
    return (Object.keys(platformSettingSchemas) as PlatformSettingKey[]).map((key) => {
      const row = byKey.get(key);
      const parsed = row ? platformSettingSchemas[key].safeParse(row.value) : null;
      return { key, value: parsed?.success ? parsed.data : this.defaults[key], updatedAt: row?.updatedAt ?? null };
    });
  }

  async set(key: string, value: unknown, actorId: string): Promise<unknown> {
    if (!PlatformSettingsService.isKnownKey(key)) throw notFound("Setting");
    const parsed = platformSettingSchemas[key].safeParse(value);
    if (!parsed.success) throw badRequest(ErrorCode.VALIDATION_FAILED, "Invalid setting value", { issues: parsed.error.issues.map((issue) => issue.message) });
    await this.db.platformSetting.upsert({
      where: { key },
      create: { key, value: parsed.data, updatedById: actorId },
      update: { value: parsed.data, updatedById: actorId },
    });
    try {
      await this.redis.del(this.keys.key("settings", key));
    } catch (error) {
      this.logger.warn({ err: error }, "settings cache invalidation failed");
    }
    return parsed.data;
  }
}
