import { mfaSecretAad } from "../../core/crypto/encrypted-columns.js";
import QRCode from "qrcode";
import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory, AuditOutcome } from "../../core/audit/audit-service.js";
import type { FieldEncryptor } from "../../core/crypto/field-encryption.js";
import { hmacSha256Hex, randomHumanCode, sha256Hex } from "../../core/crypto/random.js";
import type { Database, Tx } from "../../core/database/prisma.js";
import { AppError, ErrorCode, conflict, unauthorized } from "../../core/http/errors.js";
import type { ClientInfo, RequestMeta } from "../../core/http/request-context.js";
import type { RateLimitService } from "../../core/security/rate-limiter.js";
import { buildOtpAuthUri, generateTotpSecret, verifyTotp } from "../../core/security/totp.js";
import { MfaFactorStatus, MfaFactorType, SessionRevocationReason } from "../../generated/prisma/enums.js";
import type { AuthenticatedResult, LoginChallengeContext } from "./auth.types.js";
import { MAX_CHALLENGE_ATTEMPTS, type LoginFlowService } from "./login-flow.service.js";
import type { SecurityNotifier } from "./security-notifier.js";
import type { SessionService } from "./session.service.js";

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;

export function formatRecoveryCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export class MfaService {
  constructor(
    private readonly db: Database,
    private readonly encryptor: FieldEncryptor,
    private readonly pepper: string,
    private readonly issuer: string,
    private readonly rateLimits: RateLimitService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly loginFlow: LoginFlowService,
    private readonly securityNotifier: SecurityNotifier,
  ) {}

  private secretAad(userId: string): string {
    return mfaSecretAad(userId);
  }

  private recoveryHash(userId: string, code: string): string {
    return hmacSha256Hex(this.pepper, `recovery:${userId}:${normalizeRecoveryCode(code)}`);
  }

  async status(userId: string) {
    const [factor, remaining] = await Promise.all([
      this.db.mfaFactor.findUnique({ where: { userId_type: { userId, type: MfaFactorType.TOTP } }, select: { status: true, confirmedAt: true, createdAt: true } }),
      this.db.recoveryCode.count({ where: { userId, usedAt: null } }),
    ]);
    return {
      enabled: factor?.status === MfaFactorStatus.ACTIVE,
      totp: factor ? { status: factor.status, confirmedAt: factor.confirmedAt, createdAt: factor.createdAt } : null,
      recoveryCodesRemaining: factor?.status === MfaFactorStatus.ACTIVE ? remaining : 0,
    };
  }

  async beginTotpSetup(userId: string, meta: RequestMeta) {
    await this.rateLimits.consume("mfaManageUser", userId);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    const existing = await this.db.mfaFactor.findUnique({ where: { userId_type: { userId, type: MfaFactorType.TOTP } } });
    if (existing?.status === MfaFactorStatus.ACTIVE) throw conflict(ErrorCode.MFA_ALREADY_ENABLED, "Two-factor authentication already enabled");
    const secret = generateTotpSecret();
    const ciphertext = this.encryptor.encrypt(secret, this.secretAad(userId));
    await this.db.mfaFactor.upsert({
      where: { userId_type: { userId, type: MfaFactorType.TOTP } },
      create: { userId, type: MfaFactorType.TOTP, status: MfaFactorStatus.PENDING, secretCiphertext: ciphertext },
      update: { status: MfaFactorStatus.PENDING, secretCiphertext: ciphertext, lastUsedStep: null, confirmedAt: null },
    });
    await this.audit.record({ action: "auth.mfa.setup_started", category: AuditCategory.SECURITY, actorId: userId, meta });
    const otpauthUri = buildOtpAuthUri({ secret, accountName: user.email, issuer: this.issuer });
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: "M", margin: 1, width: 240 });
    return { secret, otpauthUri, qrCodeDataUrl };
  }

  private async generateRecoveryCodes(tx: Tx, userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomHumanCode(RECOVERY_CODE_LENGTH));
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({ data: codes.map((code) => ({ userId, codeHash: this.recoveryHash(userId, code) })) });
    return codes.map(formatRecoveryCode);
  }

  async confirmTotp(userId: string, sessionId: string, code: string, meta: RequestMeta): Promise<{ recoveryCodes: string[] }> {
    await this.rateLimits.consume("mfaVerifyUser", userId);
    const factor = await this.db.mfaFactor.findUnique({ where: { userId_type: { userId, type: MfaFactorType.TOTP } } });
    if (!factor || factor.status !== MfaFactorStatus.PENDING) throw conflict(ErrorCode.BUSINESS_RULE, "No pending two-factor setup");
    const secret = this.encryptor.decrypt(factor.secretCiphertext, this.secretAad(userId));
    const verification = verifyTotp(secret, code);
    if (!verification.valid) {
      await this.audit.record({ action: "auth.mfa.confirm_failed", category: AuditCategory.SECURITY, outcome: AuditOutcome.FAILURE, actorId: userId, meta });
      throw new AppError(400, ErrorCode.MFA_INVALID, "Invalid verification code");
    }
    const recoveryCodes = await this.db.$transaction(async (tx) => {
      await tx.mfaFactor.update({
        where: { id: factor.id },
        data: { status: MfaFactorStatus.ACTIVE, confirmedAt: new Date(), lastUsedStep: BigInt(verification.step!) },
      });
      await tx.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
      const codes = await this.generateRecoveryCodes(tx, userId);
      await this.audit.record({ action: "auth.mfa.enabled", category: AuditCategory.SECURITY, actorId: userId, meta }, tx);
      await this.securityNotifier.notify(tx, userId, "mfaEnabled", {}, meta.requestId);
      return codes;
    });
    await this.sessions.markMfaVerified(sessionId);
    await this.sessions.revokeAll(userId, SessionRevocationReason.MFA_CHANGED, sessionId);
    return { recoveryCodes };
  }

  async verifySecondFactor(userId: string, input: { code?: string; recoveryCode?: string }): Promise<boolean> {
    if (input.code) {
      const factor = await this.db.mfaFactor.findUnique({ where: { userId_type: { userId, type: MfaFactorType.TOTP } } });
      if (!factor || factor.status !== MfaFactorStatus.ACTIVE) return false;
      const secret = this.encryptor.decrypt(factor.secretCiphertext, this.secretAad(userId));
      const verification = verifyTotp(secret, input.code, { lastUsedStep: factor.lastUsedStep === null ? null : Number(factor.lastUsedStep) });
      if (!verification.valid) return false;
      const updated = await this.db.mfaFactor.updateMany({
        where: {
          id: factor.id,
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(verification.step!) } }],
        },
        data: { lastUsedStep: BigInt(verification.step!) },
      });
      return updated.count === 1;
    }
    if (input.recoveryCode) {
      const result = await this.db.recoveryCode.updateMany({
        where: { userId, codeHash: this.recoveryHash(userId, input.recoveryCode), usedAt: null },
        data: { usedAt: new Date() },
      });
      return result.count === 1;
    }
    return false;
  }

  async completeChallenge(
    input: { challengeToken: string; code?: string; recoveryCode?: string },
    client: ClientInfo,
    meta: RequestMeta,
  ): Promise<AuthenticatedResult> {
    const challenge = await this.db.loginChallenge.findUnique({
      where: { tokenHash: sha256Hex(input.challengeToken) },
      include: { user: true },
    });
    const now = new Date();
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now || challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      throw unauthorized(ErrorCode.TOKEN_INVALID, "Invalid or expired challenge");
    }
    await this.rateLimits.consume("mfaVerifyUser", challenge.userId);
    const valid = await this.verifySecondFactor(challenge.userId, input);
    if (!valid) {
      await this.db.loginChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
      await this.audit.record({
        action: "auth.mfa.challenge_failed",
        category: AuditCategory.SECURITY,
        outcome: AuditOutcome.FAILURE,
        actorId: challenge.userId,
        metadata: { method: input.recoveryCode ? "recovery_code" : "totp" },
        meta,
      });
      throw new AppError(401, ErrorCode.MFA_INVALID, "Invalid verification code");
    }
    const consumed = await this.db.loginChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: now } });
    if (consumed.count !== 1) throw unauthorized(ErrorCode.TOKEN_INVALID, "Invalid or expired challenge");
    if (input.recoveryCode) {
      await this.audit.record({ action: "auth.mfa.recovery_code_used", category: AuditCategory.SECURITY, actorId: challenge.userId, meta });
    }
    const context = challenge.context as unknown as LoginChallengeContext;
    if (challenge.user.status !== "ACTIVE") throw unauthorized(ErrorCode.SESSION_REVOKED, "Account unavailable");
    return this.loginFlow.complete({
      user: challenge.user,
      client,
      meta,
      authMethod: context.authMethod,
      provider: context.provider,
      mfaVerified: true,
    });
  }

  async disable(userId: string, secondFactor: { code?: string; recoveryCode?: string }, meta: RequestMeta): Promise<void> {
    await this.rateLimits.consume("mfaManageUser", userId);
    const status = await this.status(userId);
    if (!status.enabled) throw conflict(ErrorCode.MFA_NOT_ENABLED, "Two-factor authentication is not enabled");
    if (!(await this.verifySecondFactor(userId, secondFactor))) {
      await this.audit.record({ action: "auth.mfa.disable_failed", category: AuditCategory.SECURITY, outcome: AuditOutcome.FAILURE, actorId: userId, meta });
      throw new AppError(400, ErrorCode.MFA_INVALID, "Invalid verification code");
    }
    await this.db.$transaction(async (tx) => {
      await tx.mfaFactor.deleteMany({ where: { userId } });
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.user.update({ where: { id: userId }, data: { mfaEnabled: false } });
      await this.audit.record({ action: "auth.mfa.disabled", category: AuditCategory.SECURITY, actorId: userId, meta }, tx);
      await this.securityNotifier.notify(tx, userId, "mfaDisabled", {}, meta.requestId);
    });
  }

  async regenerateRecoveryCodes(userId: string, secondFactor: { code?: string }, meta: RequestMeta): Promise<{ recoveryCodes: string[] }> {
    await this.rateLimits.consume("mfaManageUser", userId);
    const status = await this.status(userId);
    if (!status.enabled) throw conflict(ErrorCode.MFA_NOT_ENABLED, "Two-factor authentication is not enabled");
    if (!(await this.verifySecondFactor(userId, { code: secondFactor.code }))) {
      throw new AppError(400, ErrorCode.MFA_INVALID, "Invalid verification code");
    }
    const recoveryCodes = await this.db.$transaction(async (tx) => {
      const codes = await this.generateRecoveryCodes(tx, userId);
      await this.audit.record({ action: "auth.mfa.recovery_codes_regenerated", category: AuditCategory.SECURITY, actorId: userId, meta }, tx);
      await this.securityNotifier.notify(tx, userId, "recoveryCodesRegenerated", {}, meta.requestId);
      return codes;
    });
    return { recoveryCodes };
  }
}
