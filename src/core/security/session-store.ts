import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Database } from "../database/prisma.js";
import { UserStatus } from "../../generated/prisma/enums.js";
import type { RedisKeys } from "../redis/redis.js";

export interface SessionSnapshot {
  id: string;
  userId: string;
  userStatus: UserStatus;
  revoked: boolean;
  expiresAt: number;
  idleExpiresAt: number;
  mfaVerified: boolean;
  authenticatedAt: number;
}

interface CachedSession {
  version: string;
  snapshot: SessionSnapshot;
}

const CACHE_TTL_SECONDS = 60;
const VERSION_TTL_SECONDS = 86_400;
const TOUCH_INTERVAL_SECONDS = 300;

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly keys: RedisKeys,
    private readonly logger: Logger,
  ) {}

  private cacheKey(sessionId: string): string {
    return this.keys.key("session", `{${sessionId}}`);
  }

  private versionKey(sessionId: string): string {
    return this.keys.key("session-version", `{${sessionId}}`);
  }

  async load(sessionId: string): Promise<SessionSnapshot | null> {
    let version: string | null = null;
    try {
      const [cached, currentVersion] = await Promise.all([this.redis.get(this.cacheKey(sessionId)), this.redis.get(this.versionKey(sessionId))]);
      version = currentVersion ?? "0";
      if (cached) {
        const entry = JSON.parse(cached) as Partial<CachedSession>;
        if (entry.version === version && entry.snapshot) return entry.snapshot;
      }
    } catch (error) {
      this.logger.warn({ err: error }, "session cache read failed");
    }
    const session = await this.db.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        expiresAt: true,
        idleExpiresAt: true,
        mfaVerified: true,
        authenticatedAt: true,
        user: { select: { status: true } },
      },
    });
    if (!session) return null;
    const snapshot: SessionSnapshot = {
      id: session.id,
      userId: session.userId,
      userStatus: session.user.status,
      revoked: session.revokedAt !== null,
      expiresAt: session.expiresAt.getTime(),
      idleExpiresAt: session.idleExpiresAt.getTime(),
      mfaVerified: session.mfaVerified,
      authenticatedAt: session.authenticatedAt.getTime(),
    };
    if (version !== null) {
      try {
        const entry: CachedSession = { version, snapshot };
        await this.redis.set(this.cacheKey(sessionId), JSON.stringify(entry), "EX", CACHE_TTL_SECONDS);
      } catch (error) {
        this.logger.warn({ err: error }, "session cache write failed");
      }
    }
    return snapshot;
  }

  static isUsable(snapshot: SessionSnapshot | null, now = Date.now()): snapshot is SessionSnapshot {
    return (
      snapshot !== null &&
      !snapshot.revoked &&
      snapshot.userStatus === UserStatus.ACTIVE &&
      snapshot.expiresAt > now &&
      snapshot.idleExpiresAt > now
    );
  }

  async invalidate(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    try {
      const transaction = this.redis.multi();
      for (const id of sessionIds) {
        transaction.incr(this.versionKey(id));
        transaction.expire(this.versionKey(id), VERSION_TTL_SECONDS);
        transaction.del(this.cacheKey(id));
      }
      await transaction.exec();
    } catch (error) {
      this.logger.error({ err: error }, "session cache invalidation failed");
    }
  }

  async touch(sessionId: string): Promise<void> {
    try {
      const acquired = await this.redis.set(this.keys.key("session-touch", sessionId), "1", "EX", TOUCH_INTERVAL_SECONDS, "NX");
      if (acquired !== "OK") return;
      await this.db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { lastSeenAt: new Date() } });
    } catch (error) {
      this.logger.warn({ err: error }, "session touch failed");
    }
  }
}
