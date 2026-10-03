import type { Database } from "../../core/database/prisma.js";
import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory, AuditOutcome } from "../../core/audit/audit-service.js";
import { randomToken, sha256Hex } from "../../core/crypto/random.js";
import type { ClientInfo, RequestMeta } from "../../core/http/request-context.js";
import type { Metrics } from "../../core/observability/metrics.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { AuthMethod, OAuthProvider } from "../../generated/prisma/enums.js";
import type { AuthenticatedResult, LoginChallengeContext, MfaRequiredResult } from "./auth.types.js";
import type { SecurityNotifier } from "./security-notifier.js";
import type { SessionService } from "./session.service.js";

const CHALLENGE_TTL_SECONDS = 300;
export const MAX_CHALLENGE_ATTEMPTS = 5;

export interface LoginSubject {
  id: string;
  email: string;
  displayName: string;
  emailVerifiedAt: Date | null;
  mfaEnabled: boolean;
}

export class LoginFlowService {
  constructor(
    private readonly db: Database,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly securityNotifier: SecurityNotifier,
    private readonly metrics: Metrics,
  ) {}

  async createChallenge(userId: string, context: LoginChallengeContext): Promise<MfaRequiredResult> {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
    await this.db.loginChallenge.create({
      data: { userId, tokenHash: sha256Hex(token), expiresAt, context: context as unknown as Prisma.InputJsonValue },
    });
    this.metrics.authEvents.inc({ event: "mfa_challenge", outcome: "issued" });
    return { status: "MFA_REQUIRED", challengeToken: token, challengeExpiresAt: expiresAt, methods: ["TOTP", "RECOVERY_CODE"] };
  }

  async complete(params: {
    user: LoginSubject;
    client: ClientInfo;
    meta: RequestMeta;
    authMethod: AuthMethod;
    provider: OAuthProvider | null;
    mfaVerified: boolean;
  }): Promise<AuthenticatedResult> {
    const { user, client } = params;
    const outcome = await this.db.$transaction(async (tx) => {
      const device = await this.sessions.resolveDevice(tx, user.id, client);
      const session = await this.sessions.create(tx, {
        userId: user.id,
        client,
        deviceId: device.deviceId,
        authMethod: params.authMethod,
        provider: params.provider,
        mfaVerified: params.mfaVerified,
      });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await this.audit.record(
        {
          action: "auth.login.succeeded",
          category: AuditCategory.SECURITY,
          outcome: AuditOutcome.SUCCESS,
          actorId: user.id,
          resourceType: "session",
          resourceId: session.sessionId,
          metadata: {
            method: params.authMethod,
            provider: params.provider,
            mfa: params.mfaVerified,
            platform: client.platform,
            newDevice: device.isNew,
          },
          meta: params.meta,
        },
        tx,
      );
      if (device.isNew && device.hadOtherDevices) {
        const deviceLabel = client.deviceName ?? `${client.platform}${client.userAgent ? ` · ${client.userAgent.slice(0, 60)}` : ""}`;
        await this.securityNotifier.notify(tx, user.id, "newLogin", { device: deviceLabel }, params.meta.requestId);
      }
      return session;
    });
    this.metrics.authEvents.inc({ event: "login", outcome: "success" });
    return {
      status: "AUTHENTICATED",
      session: outcome,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        emailVerified: user.emailVerifiedAt !== null,
        mfaEnabled: user.mfaEnabled,
      },
    };
  }
}
