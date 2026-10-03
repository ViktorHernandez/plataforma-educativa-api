import type { Logger } from "pino";
import type { Database, DbClient } from "../../core/database/prisma.js";
import { randomToken, sha256Hex } from "../../core/crypto/random.js";
import { AppError, ErrorCode, notFound, unauthorized } from "../../core/http/errors.js";
import type { ClientInfo } from "../../core/http/request-context.js";
import type { RealtimeBus } from "../../core/realtime/realtime-bus.js";
import { rooms } from "../../core/realtime/realtime-bus.js";
import type { AccessTokenService } from "../../core/security/access-tokens.js";
import type { SessionStore } from "../../core/security/session-store.js";
import { AuthMethod, SessionRevocationReason, UserStatus, type OAuthProvider } from "../../generated/prisma/enums.js";

export interface SessionPolicy {
  refreshTtlDays: number;
  idleTimeoutDays: number;
  reuseGraceSeconds: number;
}

export interface IssuedSession {
  sessionId: string;
  userId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface DeviceResolution {
  deviceId: string;
  isNew: boolean;
  hadOtherDevices: boolean;
}

export type RefreshOutcome =
  | { kind: "rotated"; session: IssuedSession }
  | { kind: "reuse-detected"; userId: string; sessionId: string };

const DAY_MS = 24 * 60 * 60 * 1000;

export function authMethodsFor(method: AuthMethod, provider: OAuthProvider | null, mfa: boolean): string[] {
  const methods = [method === AuthMethod.PASSWORD ? "pwd" : `oauth:${provider?.toLowerCase() ?? "unknown"}`];
  if (mfa) methods.push("otp");
  return methods;
}

export class SessionService {
  constructor(
    private readonly db: Database,
    private readonly accessTokens: AccessTokenService,
    private readonly store: SessionStore,
    private readonly realtime: RealtimeBus,
    private readonly policy: SessionPolicy,
    private readonly logger: Logger,
  ) {}

  static deviceKeyHash(userId: string, client: ClientInfo): string {
    const material = client.deviceKey ? `device:${client.deviceKey}` : `fallback:${client.platform}:${client.userAgent ?? "unknown"}`;
    return sha256Hex(`${userId}:${material}`);
  }

  async resolveDevice(tx: DbClient, userId: string, client: ClientInfo): Promise<DeviceResolution> {
    const deviceKeyHash = SessionService.deviceKeyHash(userId, client);
    const existing = await tx.userDevice.findUnique({ where: { userId_deviceKeyHash: { userId, deviceKeyHash } } });
    if (existing) {
      await tx.userDevice.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date(), lastIp: client.ip, userAgent: client.userAgent, name: client.deviceName ?? existing.name },
      });
      return { deviceId: existing.id, isNew: false, hadOtherDevices: true };
    }
    const otherDevices = await tx.userDevice.count({ where: { userId } });
    const created = await tx.userDevice.create({
      data: {
        userId,
        deviceKeyHash,
        name: client.deviceName,
        platform: client.platform,
        userAgent: client.userAgent,
        lastIp: client.ip,
      },
    });
    return { deviceId: created.id, isNew: true, hadOtherDevices: otherDevices > 0 };
  }

  async create(
    tx: DbClient,
    params: {
      userId: string;
      client: ClientInfo;
      deviceId: string | null;
      authMethod: AuthMethod;
      provider: OAuthProvider | null;
      mfaVerified: boolean;
    },
  ): Promise<IssuedSession> {
    const now = Date.now();
    const expiresAt = new Date(now + this.policy.refreshTtlDays * DAY_MS);
    const idleExpiresAt = new Date(Math.min(expiresAt.getTime(), now + this.policy.idleTimeoutDays * DAY_MS));
    const session = await tx.session.create({
      data: {
        userId: params.userId,
        deviceId: params.deviceId,
        platform: params.client.platform,
        authMethod: params.authMethod,
        authProvider: params.provider,
        mfaVerified: params.mfaVerified,
        ipAddress: params.client.ip,
        userAgent: params.client.userAgent,
        expiresAt,
        idleExpiresAt,
      },
    });
    const refreshToken = randomToken(32);
    await tx.refreshToken.create({ data: { sessionId: session.id, tokenHash: sha256Hex(refreshToken), expiresAt: idleExpiresAt } });
    const access = await this.accessTokens.sign({
      userId: params.userId,
      sessionId: session.id,
      authMethods: authMethodsFor(params.authMethod, params.provider, params.mfaVerified),
      mfa: params.mfaVerified,
    });
    return {
      sessionId: session.id,
      userId: params.userId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: idleExpiresAt,
    };
  }

  async refresh(rawToken: string, client: ClientInfo): Promise<RefreshOutcome> {
    if (rawToken.length < 20 || rawToken.length > 200) throw unauthorized(ErrorCode.TOKEN_INVALID, "Invalid refresh token");
    const tokenHash = sha256Hex(rawToken);
    const record = await this.db.refreshToken.findUnique({
      where: { tokenHash },
      include: { session: { include: { user: { select: { id: true, status: true } } } } },
    });
    if (!record) throw unauthorized(ErrorCode.TOKEN_INVALID, "Invalid refresh token");
    const session = record.session;
    const now = new Date();

    if (session.revokedAt || session.expiresAt <= now || session.user.status !== UserStatus.ACTIVE) {
      throw unauthorized(ErrorCode.SESSION_REVOKED, "Session is no longer valid");
    }

    if (record.rotatedAt) {
      const elapsed = (now.getTime() - record.rotatedAt.getTime()) / 1000;
      if (elapsed <= this.policy.reuseGraceSeconds) {
        throw new AppError(409, ErrorCode.REFRESH_TOKEN_ROTATED, "Refresh token already rotated");
      }
      await this.revoke(session.id, SessionRevocationReason.REFRESH_REUSE);
      return { kind: "reuse-detected", userId: session.userId, sessionId: session.id };
    }

    if (record.expiresAt <= now || session.idleExpiresAt <= now) {
      throw unauthorized(ErrorCode.SESSION_REVOKED, "Session expired");
    }

    const idleExpiresAt = new Date(Math.min(session.expiresAt.getTime(), now.getTime() + this.policy.idleTimeoutDays * DAY_MS));
    const newToken = randomToken(32);
    const rotated = await this.db.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({ where: { id: record.id, rotatedAt: null }, data: { rotatedAt: now } });
      if (claimed.count !== 1) return false;
      await tx.refreshToken.create({ data: { sessionId: session.id, tokenHash: sha256Hex(newToken), expiresAt: idleExpiresAt } });
      await tx.session.update({
        where: { id: session.id },
        data: { lastSeenAt: now, idleExpiresAt, ipAddress: client.ip, userAgent: client.userAgent ?? session.userAgent },
      });
      return true;
    });
    if (!rotated) throw new AppError(409, ErrorCode.REFRESH_TOKEN_ROTATED, "Refresh token already rotated");
    await this.store.invalidate([session.id]);

    const access = await this.accessTokens.sign({
      userId: session.userId,
      sessionId: session.id,
      authMethods: authMethodsFor(session.authMethod, session.authProvider, session.mfaVerified),
      mfa: session.mfaVerified,
    });
    return {
      kind: "rotated",
      session: {
        sessionId: session.id,
        userId: session.userId,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: newToken,
        refreshTokenExpiresAt: idleExpiresAt,
      },
    };
  }

  async findSessionIdByRefreshToken(rawToken: string): Promise<{ sessionId: string; userId: string } | null> {
    if (rawToken.length < 20 || rawToken.length > 200) return null;
    const record = await this.db.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
      select: { session: { select: { id: true, userId: true } } },
    });
    return record ? { sessionId: record.session.id, userId: record.session.userId } : null;
  }

  async revoke(sessionId: string, reason: SessionRevocationReason): Promise<boolean> {
    const result = await this.db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await this.afterRevocation([sessionId], reason);
    return result.count > 0;
  }

  async revokeForUser(userId: string, sessionId: string, reason: SessionRevocationReason): Promise<void> {
    const session = await this.db.session.findFirst({ where: { id: sessionId, userId }, select: { id: true } });
    if (!session) throw notFound("Session");
    await this.revoke(session.id, reason);
  }

  async revokeAll(userId: string, reason: SessionRevocationReason, exceptSessionId?: string): Promise<number> {
    const sessions = await this.db.session.findMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      select: { id: true },
    });
    if (sessions.length === 0) return 0;
    const ids = sessions.map((session) => session.id);
    await this.db.session.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    await this.afterRevocation(ids, reason);
    return ids.length;
  }

  private async afterRevocation(sessionIds: string[], reason: SessionRevocationReason): Promise<void> {
    await this.store.invalidate(sessionIds);
    await Promise.all(sessionIds.map((id) => this.realtime.disconnect(rooms.session(id), `session_revoked:${reason.toLowerCase()}`)));
    this.logger.info({ sessions: sessionIds.length, reason }, "sessions revoked");
  }

  async markMfaVerified(sessionId: string): Promise<void> {
    await this.db.session.update({ where: { id: sessionId }, data: { mfaVerified: true, authenticatedAt: new Date() } });
    await this.store.invalidate([sessionId]);
  }

  async list(userId: string, currentSessionId: string | null) {
    const sessions = await this.db.session.findMany({
      where: { userId },
      orderBy: { lastSeenAt: "desc" },
      take: 100,
      include: { device: { select: { id: true, name: true, platform: true } } },
    });
    const now = new Date();
    return sessions.map((session) => ({
      id: session.id,
      current: session.id === currentSessionId,
      active: !session.revokedAt && session.expiresAt > now && session.idleExpiresAt > now,
      platform: session.platform,
      authMethod: session.authMethod,
      authProvider: session.authProvider,
      mfaVerified: session.mfaVerified,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      device: session.device,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      revokedReason: session.revokedReason,
    }));
  }
}
