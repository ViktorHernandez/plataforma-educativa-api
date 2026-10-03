import type { AppConfig } from "../../config/env.js";
import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory, AuditOutcome } from "../../core/audit/audit-service.js";
import type { Database } from "../../core/database/prisma.js";
import { isUniqueViolation } from "../../core/database/prisma.js";
import { sha256Hex } from "../../core/crypto/random.js";
import { AppError, ErrorCode, badRequest, forbidden, unauthorized, unprocessable } from "../../core/http/errors.js";
import type { ClientInfo, RequestMeta } from "../../core/http/request-context.js";
import type { SupportedLocale } from "../../core/i18n/translator.js";
import type { EmailQueue } from "../../core/mail/email-queue.js";
import { EmailTemplate } from "../../core/mail/templates.js";
import type { Metrics } from "../../core/observability/metrics.js";
import type { BreachChecker, PasswordHasher, PasswordPolicy } from "../../core/security/password.js";
import { RateLimitService } from "../../core/security/rate-limiter.js";
import { AuthMethod, SessionRevocationReason, UserStatus, VerificationPurpose } from "../../generated/prisma/enums.js";
import type { PlatformSettingsService } from "../admin/platform-settings.service.js";
import type { AuthenticatedResult, LoginResult } from "./auth.types.js";
import type { LoginFlowService } from "./login-flow.service.js";
import type { SecurityNotifier } from "./security-notifier.js";
import type { SessionService } from "./session.service.js";
import type { VerificationTokenService } from "./verification-token.service.js";

const EMAIL_VERIFICATION_TTL_SECONDS = 48 * 3600;
const PASSWORD_RESET_TTL_SECONDS = 30 * 60;
export const ACCOUNT_SETUP_TTL_SECONDS = 7 * 24 * 3600;
const REAUTH_WINDOW_MS = 10 * 60 * 1000;

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  timezone?: string;
  acceptTerms: true;
}

export interface ReauthInput {
  password?: string;
  totpCode?: string;
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly hasher: PasswordHasher,
    private readonly policy: PasswordPolicy,
    private readonly breachChecker: BreachChecker,
    private readonly rateLimits: RateLimitService,
    private readonly audit: AuditService,
    private readonly tokens: VerificationTokenService,
    private readonly sessions: SessionService,
    private readonly loginFlow: LoginFlowService,
    private readonly emails: EmailQueue,
    private readonly securityNotifier: SecurityNotifier,
    private readonly settings: PlatformSettingsService,
    private readonly metrics: Metrics,
    private readonly verifyTotpForUser: (userId: string, code: string) => Promise<boolean>,
  ) {}

  async assertAcceptablePassword(password: string, context: { email?: string; displayName?: string }): Promise<void> {
    const evaluation = this.policy.evaluate(password, context);
    if (!evaluation.valid) {
      throw unprocessable(ErrorCode.PASSWORD_POLICY, "Password does not meet the policy", {
        issues: evaluation.issues,
        ...this.policy.limits,
      });
    }
    if (await this.breachChecker.isBreached(password)) {
      throw unprocessable(ErrorCode.PASSWORD_BREACHED, "Password found in a known breach");
    }
  }

  private webLink(path: string, token: string): string {
    const url = new URL(path, this.config.WEB_APP_URL);
    url.searchParams.set("token", token);
    return url.toString();
  }

  async register(input: RegisterInput, client: ClientInfo, meta: RequestMeta, locale: SupportedLocale): Promise<void> {
    await this.rateLimits.consume("registerIp", client.ip);
    const registrationEnabled = this.config.REGISTRATION_ENABLED && (await this.settings.get("registration.enabled"));
    if (!registrationEnabled) throw forbidden("Registration is disabled", ErrorCode.REGISTRATION_DISABLED);
    const allowedDomains = await this.settings.get("registration.allowedEmailDomains");
    const domain = input.email.split("@")[1] ?? "";
    if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
      throw forbidden("Registration is disabled", ErrorCode.REGISTRATION_DISABLED);
    }
    await this.assertAcceptablePassword(input.password, { email: input.email, displayName: input.displayName });

    const existing = await this.db.user.findUnique({ where: { email: input.email } });
    if (existing && existing.status !== UserStatus.PENDING_VERIFICATION) {
      await this.hasher.simulateVerification(input.password);
      try {
        await this.rateLimits.consume("verificationResendAccount", RateLimitService.subject(`exists:${input.email}`));
        await this.db.$transaction(async (tx) => {
          const preference = await tx.userPreference.findUnique({ where: { userId: existing.id } });
          await this.emails.enqueue(tx, {
            template: EmailTemplate.AccountExists,
            to: existing.email,
            userId: existing.id,
            locale: preference?.locale ?? locale,
            timezone: preference?.timezone,
            values: { name: existing.displayName },
            actionUrl: new URL("/forgot-password", this.config.WEB_APP_URL).toString(),
            requestId: meta.requestId,
          });
        });
      } catch (error) {
        if (!(error instanceof AppError && error.code === ErrorCode.RATE_LIMITED)) throw error;
      }
      await this.audit.record({ action: "auth.register.duplicate", category: AuditCategory.SECURITY, outcome: AuditOutcome.FAILURE, actorId: null, resourceType: "user", resourceId: existing.id, meta });
      return;
    }

    if (existing) {
      try {
        await this.rateLimits.consume("verificationResendAccount", RateLimitService.subject(`pending:${input.email}`));
      } catch (error) {
        if (error instanceof AppError && error.code === ErrorCode.RATE_LIMITED) {
          await this.hasher.simulateVerification(input.password);
          return;
        }
        throw error;
      }
    }
    const passwordHash = await this.hasher.hash(input.password);
    try {
      await this.db.$transaction(async (tx) => {
        const user = existing
          ? await tx.user.update({ where: { id: existing.id }, data: { passwordHash, displayName: input.displayName, passwordChangedAt: new Date() } })
          : await tx.user.create({
              data: {
                email: input.email,
                displayName: input.displayName,
                passwordHash,
                passwordChangedAt: new Date(),
                status: UserStatus.PENDING_VERIFICATION,
                profile: { create: {} },
                preference: { create: { locale, timezone: input.timezone ?? "UTC" } },
              },
            });
        const { token } = await this.tokens.issue(tx, { userId: user.id, purpose: VerificationPurpose.EMAIL_VERIFICATION, ttlSeconds: EMAIL_VERIFICATION_TTL_SECONDS });
        await this.emails.enqueue(tx, {
          template: EmailTemplate.VerifyEmail,
          to: user.email,
          userId: user.id,
          locale,
          timezone: input.timezone,
          values: { name: user.displayName, hours: EMAIL_VERIFICATION_TTL_SECONDS / 3600 },
          actionUrl: this.webLink("/verify-email", token),
          requestId: meta.requestId,
        });
        await this.audit.record(
          { action: "auth.register.succeeded", category: AuditCategory.SECURITY, actorId: user.id, resourceType: "user", resourceId: user.id, meta, metadata: { platform: client.platform } },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error, "email")) return;
      throw error;
    }
    this.metrics.authEvents.inc({ event: "register", outcome: "success" });
  }

  async verifyEmail(token: string, client: ClientInfo, meta: RequestMeta): Promise<void> {
    await this.rateLimits.consume("tokenRedeemIp", client.ip);
    await this.db.$transaction(async (tx) => {
      const consumed = await this.tokens.consume(tx, token, VerificationPurpose.EMAIL_VERIFICATION);
      if (!consumed) throw badRequest(ErrorCode.TOKEN_ALREADY_USED, "Invalid or expired token");
      const user = await tx.user.findUnique({ where: { id: consumed.userId } });
      if (!user) throw badRequest(ErrorCode.TOKEN_ALREADY_USED, "Invalid or expired token");
      await tx.user.update({
        where: { id: user.id },
        data: {
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
          status: user.status === UserStatus.PENDING_VERIFICATION ? UserStatus.ACTIVE : user.status,
        },
      });
      await this.audit.record({ action: "auth.email.verified", category: AuditCategory.SECURITY, actorId: user.id, resourceType: "user", resourceId: user.id, meta }, tx);
    });
  }

  async resendVerification(email: string, client: ClientInfo, meta: RequestMeta): Promise<void> {
    await this.rateLimits.consume("passwordForgotIp", client.ip);
    const user = await this.db.user.findUnique({ where: { email }, include: { preference: true } });
    await this.hasher.simulateVerification(email);
    if (!user || user.status !== UserStatus.PENDING_VERIFICATION) return;
    try {
      await this.rateLimits.consume("verificationResendAccount", RateLimitService.subject(`verify:${email}`));
    } catch {
      return;
    }
    await this.db.$transaction(async (tx) => {
      const { token } = await this.tokens.issue(tx, { userId: user.id, purpose: VerificationPurpose.EMAIL_VERIFICATION, ttlSeconds: EMAIL_VERIFICATION_TTL_SECONDS });
      await this.emails.enqueue(tx, {
        template: EmailTemplate.VerifyEmail,
        to: user.email,
        userId: user.id,
        locale: user.preference?.locale ?? "es",
        timezone: user.preference?.timezone,
        values: { name: user.displayName, hours: EMAIL_VERIFICATION_TTL_SECONDS / 3600 },
        actionUrl: this.webLink("/verify-email", token),
        requestId: meta.requestId,
      });
    });
  }

  async login(input: { email: string; password: string }, client: ClientInfo, meta: RequestMeta): Promise<LoginResult> {
    const accountKey = RateLimitService.subject(input.email);
    const accountIpKey = `${accountKey}:${client.ip}`;
    await this.rateLimits.consume("loginAttemptIp", client.ip);
    await this.rateLimits.assertNotBlocked("loginFailureAccountIp", accountIpKey);
    await this.rateLimits.assertNotBlocked("loginFailureAccount", accountKey);
    await this.rateLimits.assertNotBlocked("loginFailureIp", client.ip);

    const user = await this.db.user.findUnique({ where: { email: input.email } });
    const failure = async (userId: string | null, reason: string) => {
      await Promise.all([
        this.rateLimits.penalize("loginFailureAccountIp", accountIpKey),
        this.rateLimits.penalize("loginFailureAccount", accountKey),
        this.rateLimits.penalize("loginFailureIp", client.ip),
      ]);
      await this.audit.record({
        action: "auth.login.failed",
        category: AuditCategory.SECURITY,
        outcome: AuditOutcome.FAILURE,
        actorId: userId,
        resourceType: "user",
        resourceId: userId ?? undefined,
        metadata: { reason, account: accountKey.slice(0, 16), platform: client.platform },
        meta,
      });
      this.metrics.authEvents.inc({ event: "login", outcome: "failure" });
      return unauthorized(ErrorCode.INVALID_CREDENTIALS, "Invalid email or password");
    };

    if (!user || !user.passwordHash || user.deletedAt) {
      await this.hasher.simulateVerification(input.password);
      throw await failure(user?.id ?? null, user ? "no_password" : "unknown_account");
    }
    const valid = await this.hasher.verify(user.passwordHash, input.password);
    if (!valid) throw await failure(user.id, "bad_password");

    await this.rateLimits.reset("loginFailureAccountIp", accountIpKey);

    if (user.status === UserStatus.PENDING_VERIFICATION) {
      throw forbidden("Email not verified", ErrorCode.EMAIL_NOT_VERIFIED);
    }
    if (user.status !== UserStatus.ACTIVE) {
      await this.audit.record({ action: "auth.login.denied", category: AuditCategory.SECURITY, outcome: AuditOutcome.DENIED, actorId: user.id, metadata: { status: user.status }, meta });
      throw forbidden("Account unavailable", ErrorCode.ACCOUNT_SUSPENDED);
    }

    if (this.hasher.needsRehash(user.passwordHash)) {
      const rehashed = await this.hasher.hash(input.password);
      await this.db.user.update({ where: { id: user.id }, data: { passwordHash: rehashed } });
    }

    if (user.mfaEnabled) {
      return this.loginFlow.createChallenge(user.id, { authMethod: AuthMethod.PASSWORD, provider: null });
    }
    return this.loginFlow.complete({ user, client, meta, authMethod: AuthMethod.PASSWORD, provider: null, mfaVerified: false });
  }

  async refresh(refreshToken: string, client: ClientInfo, meta: RequestMeta) {
    await this.rateLimits.consume("refreshIp", client.ip);
    const outcome = await this.sessions.refresh(refreshToken, client);
    if (outcome.kind === "reuse-detected") {
      await this.db.$transaction(async (tx) => {
        await this.audit.record(
          { action: "auth.refresh.reuse_detected", category: AuditCategory.SECURITY, outcome: AuditOutcome.DENIED, actorId: outcome.userId, resourceType: "session", resourceId: outcome.sessionId, meta },
          tx,
        );
        await this.securityNotifier.notify(tx, outcome.userId, "sessionReuse", {}, meta.requestId);
      });
      this.metrics.authEvents.inc({ event: "refresh", outcome: "reuse_detected" });
      throw unauthorized(ErrorCode.SESSION_REVOKED, "Session revoked");
    }
    this.metrics.authEvents.inc({ event: "refresh", outcome: "success" });
    return outcome.session;
  }

  async logout(sessionId: string, userId: string, meta: RequestMeta): Promise<void> {
    await this.sessions.revoke(sessionId, SessionRevocationReason.LOGOUT);
    await this.audit.record({ action: "auth.logout", category: AuditCategory.SECURITY, actorId: userId, resourceType: "session", resourceId: sessionId, meta });
  }

  async forgotPassword(email: string, client: ClientInfo, meta: RequestMeta): Promise<void> {
    await this.rateLimits.consume("passwordForgotIp", client.ip);
    const user = await this.db.user.findUnique({ where: { email }, include: { preference: true } });
    await this.hasher.simulateVerification(email);
    if (!user || user.deletedAt || (user.status !== UserStatus.ACTIVE && user.status !== UserStatus.PENDING_VERIFICATION)) {
      return;
    }
    try {
      await this.rateLimits.consume("passwordForgotAccount", RateLimitService.subject(email));
    } catch {
      return;
    }
    await this.db.$transaction(async (tx) => {
      const { token } = await this.tokens.issue(tx, { userId: user.id, purpose: VerificationPurpose.PASSWORD_RESET, ttlSeconds: PASSWORD_RESET_TTL_SECONDS });
      await this.emails.enqueue(tx, {
        template: EmailTemplate.PasswordReset,
        to: user.email,
        userId: user.id,
        locale: user.preference?.locale ?? "es",
        timezone: user.preference?.timezone,
        values: { name: user.displayName, minutes: PASSWORD_RESET_TTL_SECONDS / 60 },
        actionUrl: this.webLink("/reset-password", token),
        requestId: meta.requestId,
      });
      await this.audit.record({ action: "auth.password.reset_requested", category: AuditCategory.SECURITY, actorId: user.id, resourceType: "user", resourceId: user.id, meta }, tx);
    });
  }

  async resetPassword(token: string, newPassword: string, client: ClientInfo, meta: RequestMeta): Promise<void> {
    await this.rateLimits.consume("tokenRedeemIp", client.ip);
    const userId = await this.consumeAndSetPassword(token, VerificationPurpose.PASSWORD_RESET, newPassword, meta, "auth.password.reset");
    await this.sessions.revokeAll(userId, SessionRevocationReason.PASSWORD_RESET);
  }

  async setupAccount(token: string, newPassword: string, client: ClientInfo, meta: RequestMeta): Promise<void> {
    await this.rateLimits.consume("tokenRedeemIp", client.ip);
    await this.consumeAndSetPassword(token, VerificationPurpose.ACCOUNT_SETUP, newPassword, meta, "auth.account.setup");
  }

  private async consumeAndSetPassword(token: string, purpose: VerificationPurpose, newPassword: string, meta: RequestMeta, action: string): Promise<string> {
    const record = await this.db.verificationToken.findFirst({
      where: { purpose, consumedAt: null, expiresAt: { gt: new Date() }, tokenHash: sha256Hex(token) },
      include: { user: true },
    });
    if (!record) throw badRequest(ErrorCode.TOKEN_ALREADY_USED, "Invalid or expired token");
    await this.assertAcceptablePassword(newPassword, { email: record.user.email, displayName: record.user.displayName });
    const passwordHash = await this.hasher.hash(newPassword);
    return this.db.$transaction(async (tx) => {
      const consumed = await this.tokens.consume(tx, token, purpose);
      if (!consumed) throw badRequest(ErrorCode.TOKEN_ALREADY_USED, "Invalid or expired token");
      const user = await tx.user.findUniqueOrThrow({ where: { id: consumed.userId } });
      if (user.status === UserStatus.SUSPENDED || user.status === UserStatus.DEACTIVATED) {
        throw forbidden("Account unavailable", ErrorCode.ACCOUNT_SUSPENDED);
      }
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
          status: UserStatus.ACTIVE,
        },
      });
      await tx.verificationToken.deleteMany({ where: { userId: user.id, purpose: { in: [VerificationPurpose.PASSWORD_RESET, VerificationPurpose.ACCOUNT_SETUP] }, consumedAt: null } });
      await this.audit.record({ action, category: AuditCategory.SECURITY, actorId: user.id, resourceType: "user", resourceId: user.id, meta }, tx);
      await this.securityNotifier.notify(tx, user.id, "passwordChanged", {}, meta.requestId);
      return user.id;
    });
  }

  async changePassword(userId: string, sessionId: string, currentPassword: string, newPassword: string, meta: RequestMeta): Promise<void> {
    await this.rateLimits.consume("sensitiveUser", userId);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash || !(await this.hasher.verify(user.passwordHash, currentPassword))) {
      await this.audit.record({ action: "auth.password.change_failed", category: AuditCategory.SECURITY, outcome: AuditOutcome.FAILURE, actorId: userId, meta });
      throw new AppError(403, ErrorCode.REAUTHENTICATION_REQUIRED, "Current password is incorrect");
    }
    if (currentPassword === newPassword) {
      throw unprocessable(ErrorCode.PASSWORD_POLICY, "The new password must be different", { issues: ["SAME_AS_CURRENT"] });
    }
    await this.assertAcceptablePassword(newPassword, { email: user.email, displayName: user.displayName });
    const passwordHash = await this.hasher.hash(newPassword);
    await this.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash, passwordChangedAt: new Date() } });
      await this.audit.record({ action: "auth.password.changed", category: AuditCategory.SECURITY, actorId: userId, resourceType: "user", resourceId: userId, meta }, tx);
      await this.securityNotifier.notify(tx, userId, "passwordChanged", {}, meta.requestId);
    });
    await this.sessions.revokeAll(userId, SessionRevocationReason.PASSWORD_CHANGED, sessionId);
  }

  async verifyReauthentication(userId: string, sessionAuthenticatedAt: Date, input: ReauthInput | undefined, meta: RequestMeta): Promise<void> {
    await this.rateLimits.consume("sensitiveUser", userId);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, mfaEnabled: true } });
    let verified: boolean;
    if (user.passwordHash) {
      verified = Boolean(input?.password) && (await this.hasher.verify(user.passwordHash, input!.password!));
    } else if (user.mfaEnabled) {
      verified = Boolean(input?.totpCode) && (await this.verifyTotpForUser(userId, input!.totpCode!));
    } else {
      verified = Date.now() - sessionAuthenticatedAt.getTime() <= REAUTH_WINDOW_MS;
    }
    if (!verified) {
      await this.audit.record({ action: "auth.reauthentication.failed", category: AuditCategory.SECURITY, outcome: AuditOutcome.FAILURE, actorId: userId, meta });
      throw new AppError(403, ErrorCode.REAUTHENTICATION_REQUIRED, "Reauthentication required");
    }
  }

  async currentUserSummary(userId: string): Promise<AuthenticatedResult["user"]> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    return { id: user.id, email: user.email, displayName: user.displayName, emailVerified: user.emailVerifiedAt !== null, mfaEnabled: user.mfaEnabled };
  }
}
