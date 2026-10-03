import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { AuditService } from "../../../core/audit/audit-service.js";
import { AuditCategory, AuditOutcome } from "../../../core/audit/audit-service.js";
import { randomToken, sha256Hex } from "../../../core/crypto/random.js";
import type { Database } from "../../../core/database/prisma.js";
import { isUniqueViolation } from "../../../core/database/prisma.js";
import { AppError, ErrorCode, badRequest, conflict, forbidden, notFound } from "../../../core/http/errors.js";
import type { ClientInfo, RequestMeta } from "../../../core/http/request-context.js";
import type { SupportedLocale } from "../../../core/i18n/translator.js";
import type { RedisKeys } from "../../../core/redis/redis.js";
import type { RateLimitService } from "../../../core/security/rate-limiter.js";
import { AuthMethod, SessionRevocationReason, UserStatus, type OAuthProvider } from "../../../generated/prisma/enums.js";
import type { PlatformSettingsService } from "../../admin/platform-settings.service.js";
import type { LoginResult } from "../auth.types.js";
import type { LoginFlowService } from "../login-flow.service.js";
import type { SecurityNotifier } from "../security-notifier.js";
import type { SessionService } from "../session.service.js";
import { OAuthProviderError, type ExternalProfile, type OAuthProviderRegistry } from "./oauth-providers.js";

const STATE_TTL_SECONDS = 600;
const EXCHANGE_TTL_SECONDS = 120;

type OAuthIntent = "login" | "link";

interface StoredState {
  provider: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  clientChallenge: string;
  intent: OAuthIntent;
  userId: string | null;
  locale: SupportedLocale;
}

interface StoredExchange {
  userId: string;
  provider: OAuthProvider;
  clientChallenge: string;
}

export interface AuthorizeInput {
  provider: string;
  redirectUri: string;
  codeChallenge: string;
  intent: OAuthIntent;
  userId: string | null;
  locale: SupportedLocale;
}

export interface CallbackOutcome {
  redirectTo: string;
}

function s256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export class OAuthService {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly keys: RedisKeys,
    private readonly registry: OAuthProviderRegistry,
    private readonly publicApiUrl: string,
    private readonly redirectAllowlist: string[],
    private readonly rateLimits: RateLimitService,
    private readonly audit: AuditService,
    private readonly loginFlow: LoginFlowService,
    private readonly sessions: SessionService,
    private readonly securityNotifier: SecurityNotifier,
    private readonly settings: PlatformSettingsService,
    private readonly registrationEnabled: boolean,
    private readonly logger: Logger,
  ) {}

  providers(): string[] {
    return this.registry.enabled();
  }

  private callbackUrl(slug: string): string {
    return `${this.publicApiUrl}/v1/auth/oauth/${slug}/callback`;
  }

  isAllowedRedirect(redirectUri: string): boolean {
    return this.redirectAllowlist.includes(redirectUri);
  }

  async authorize(input: AuthorizeInput, client: ClientInfo): Promise<{ authorizationUrl: string; expiresAt: Date }> {
    await this.rateLimits.consume("oauthIp", client.ip);
    const adapter = this.registry.get(input.provider);
    if (!adapter) throw notFound("OAuth provider");
    if (!this.isAllowedRedirect(input.redirectUri)) throw badRequest(ErrorCode.REDIRECT_NOT_ALLOWED, "Redirect URI not allowed");
    if (input.intent === "link" && !input.userId) throw new AppError(401, ErrorCode.UNAUTHENTICATED, "Authentication required to link accounts");
    const state = randomToken(32);
    const verifier = randomToken(48);
    const nonce = randomToken(16);
    const stored: StoredState = {
      provider: adapter.slug,
      verifier,
      nonce,
      redirectUri: input.redirectUri,
      clientChallenge: input.codeChallenge,
      intent: input.intent,
      userId: input.userId,
      locale: input.locale,
    };
    await this.redis.set(this.keys.key("oauth", "state", sha256Hex(state)), JSON.stringify(stored), "EX", STATE_TTL_SECONDS);
    return {
      authorizationUrl: adapter.buildAuthorizationUrl({ state, nonce, codeChallenge: s256(verifier), redirectUri: this.callbackUrl(adapter.slug) }),
      expiresAt: new Date(Date.now() + STATE_TTL_SECONDS * 1000),
    };
  }

  private redirectWith(target: string, params: Record<string, string>): string {
    const url = new URL(target);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  async handleCallback(
    providerSlug: string,
    query: { code?: string; state?: string; error?: string },
    client: ClientInfo,
    meta: RequestMeta,
  ): Promise<CallbackOutcome> {
    await this.rateLimits.consume("oauthIp", client.ip);
    if (!query.state) throw badRequest(ErrorCode.OAUTH_STATE_INVALID, "Missing state");
    const raw = await this.redis.getdel(this.keys.key("oauth", "state", sha256Hex(query.state)));
    if (!raw) throw badRequest(ErrorCode.OAUTH_STATE_INVALID, "Invalid or expired state");
    const state = JSON.parse(raw) as StoredState;
    if (state.provider !== providerSlug) throw badRequest(ErrorCode.OAUTH_STATE_INVALID, "Provider mismatch");
    const adapter = this.registry.get(providerSlug);
    if (!adapter) throw notFound("OAuth provider");

    if (query.error || !query.code) {
      return { redirectTo: this.redirectWith(state.redirectUri, { error: query.error === "access_denied" ? "access_denied" : ErrorCode.OAUTH_FAILED }) };
    }

    let profile: ExternalProfile;
    try {
      profile = await adapter.exchange({ code: query.code, codeVerifier: state.verifier, redirectUri: this.callbackUrl(adapter.slug), nonce: state.nonce });
    } catch (error) {
      this.logger.warn({ err: error instanceof OAuthProviderError ? { message: error.message } : error, provider: providerSlug }, "oauth exchange failed");
      await this.audit.record({ action: "auth.oauth.failed", category: AuditCategory.SECURITY, outcome: AuditOutcome.FAILURE, metadata: { provider: adapter.id }, meta });
      return { redirectTo: this.redirectWith(state.redirectUri, { error: ErrorCode.OAUTH_FAILED }) };
    }

    try {
      if (state.intent === "link") {
        await this.linkIdentity(state.userId!, adapter.id, profile, meta);
        return { redirectTo: this.redirectWith(state.redirectUri, { linked: adapter.slug }) };
      }
      const userId = await this.resolveLoginUser(adapter.id, profile, state.locale, meta);
      const exchangeCode = randomToken(32);
      const exchange: StoredExchange = { userId, provider: adapter.id, clientChallenge: state.clientChallenge };
      await this.redis.set(this.keys.key("oauth", "exchange", sha256Hex(exchangeCode)), JSON.stringify(exchange), "EX", EXCHANGE_TTL_SECONDS);
      return { redirectTo: this.redirectWith(state.redirectUri, { code: exchangeCode }) };
    } catch (error) {
      if (error instanceof AppError) {
        return { redirectTo: this.redirectWith(state.redirectUri, { error: error.code }) };
      }
      throw error;
    }
  }

  async exchange(input: { code: string; codeVerifier: string }, client: ClientInfo, meta: RequestMeta): Promise<LoginResult> {
    await this.rateLimits.consume("oauthIp", client.ip);
    const raw = await this.redis.getdel(this.keys.key("oauth", "exchange", sha256Hex(input.code)));
    if (!raw) throw badRequest(ErrorCode.OAUTH_STATE_INVALID, "Invalid or expired code");
    const exchange = JSON.parse(raw) as StoredExchange;
    if (s256(input.codeVerifier) !== exchange.clientChallenge) {
      await this.audit.record({ action: "auth.oauth.pkce_failed", category: AuditCategory.SECURITY, outcome: AuditOutcome.DENIED, actorId: exchange.userId, meta });
      throw badRequest(ErrorCode.OAUTH_STATE_INVALID, "Invalid code verifier");
    }
    const user = await this.db.user.findUniqueOrThrow({ where: { id: exchange.userId } });
    if (user.status !== UserStatus.ACTIVE) throw forbidden("Account unavailable", ErrorCode.ACCOUNT_SUSPENDED);
    if (user.mfaEnabled) {
      return this.loginFlow.createChallenge(user.id, { authMethod: AuthMethod.OAUTH, provider: exchange.provider });
    }
    return this.loginFlow.complete({ user, client, meta, authMethod: AuthMethod.OAUTH, provider: exchange.provider, mfaVerified: false });
  }

  private async resolveLoginUser(provider: OAuthProvider, profile: ExternalProfile, locale: SupportedLocale, meta: RequestMeta): Promise<string> {
    const identity = await this.db.externalIdentity.findUnique({
      where: { provider_providerSubject: { provider, providerSubject: profile.subject } },
      include: { user: true },
    });
    if (identity) {
      if (identity.user.status !== UserStatus.ACTIVE) throw forbidden("Account unavailable", ErrorCode.ACCOUNT_SUSPENDED);
      await this.db.externalIdentity.update({ where: { id: identity.id }, data: { lastUsedAt: new Date(), email: profile.email, emailVerified: profile.emailVerified } });
      return identity.userId;
    }
    if (!profile.email) throw badRequest(ErrorCode.OAUTH_FAILED, "The provider did not return a verified email");

    const existing = await this.db.user.findUnique({ where: { email: profile.email } });
    if (existing) {
      if (existing.status === UserStatus.PENDING_VERIFICATION && profile.emailVerified) {
        await this.db.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: existing.id },
            data: { status: UserStatus.ACTIVE, emailVerifiedAt: new Date(), passwordHash: null, passwordChangedAt: new Date() },
          });
          await tx.verificationToken.deleteMany({ where: { userId: existing.id } });
          await tx.externalIdentity.create({
            data: { userId: existing.id, provider, providerSubject: profile.subject, email: profile.email, emailVerified: true, displayName: profile.displayName, lastUsedAt: new Date() },
          });
          await this.audit.record(
            { action: "auth.oauth.unverified_account_claimed", category: AuditCategory.SECURITY, actorId: existing.id, metadata: { provider }, meta },
            tx,
          );
        });
        await this.sessions.revokeAll(existing.id, SessionRevocationReason.SECURITY);
        return existing.id;
      }
      if (existing.status === UserStatus.SUSPENDED || existing.status === UserStatus.DEACTIVATED) {
        throw forbidden("Account unavailable", ErrorCode.ACCOUNT_SUSPENDED);
      }
      await this.audit.record({ action: "auth.oauth.link_required", category: AuditCategory.SECURITY, outcome: AuditOutcome.DENIED, actorId: existing.id, metadata: { provider }, meta });
      throw conflict(ErrorCode.OAUTH_ACCOUNT_LINK_REQUIRED, "Account exists, link required");
    }

    if (!profile.emailVerified) throw badRequest(ErrorCode.OAUTH_FAILED, "The provider did not return a verified email");
    const registrationEnabled = this.registrationEnabled && (await this.settings.get("registration.enabled"));
    if (!registrationEnabled) throw forbidden("Registration is disabled", ErrorCode.REGISTRATION_DISABLED);

    try {
      const created = await this.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: profile.email!,
            displayName: (profile.displayName ?? profile.email!.split("@")[0]!).slice(0, 120),
            status: UserStatus.ACTIVE,
            emailVerifiedAt: new Date(),
            profile: { create: {} },
            preference: { create: { locale } },
            externalIdentities: {
              create: { provider, providerSubject: profile.subject, email: profile.email, emailVerified: true, displayName: profile.displayName, lastUsedAt: new Date() },
            },
          },
        });
        await this.audit.record({ action: "auth.register.oauth", category: AuditCategory.SECURITY, actorId: user.id, metadata: { provider }, meta }, tx);
        return user;
      });
      return created.id;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.OAUTH_ACCOUNT_LINK_REQUIRED, "Account exists, link required");
      throw error;
    }
  }

  private async linkIdentity(userId: string, provider: OAuthProvider, profile: ExternalProfile, meta: RequestMeta): Promise<void> {
    const taken = await this.db.externalIdentity.findUnique({ where: { provider_providerSubject: { provider, providerSubject: profile.subject } } });
    if (taken && taken.userId !== userId) {
      await this.audit.record({ action: "auth.oauth.link_conflict", category: AuditCategory.SECURITY, outcome: AuditOutcome.DENIED, actorId: userId, metadata: { provider }, meta });
      throw conflict(ErrorCode.OAUTH_IDENTITY_IN_USE, "Identity already linked");
    }
    if (taken) return;
    try {
      await this.db.$transaction(async (tx) => {
        await tx.externalIdentity.create({
          data: { userId, provider, providerSubject: profile.subject, email: profile.email, emailVerified: profile.emailVerified, displayName: profile.displayName },
        });
        await this.audit.record({ action: "auth.oauth.linked", category: AuditCategory.SECURITY, actorId: userId, metadata: { provider }, meta }, tx);
        await this.securityNotifier.notify(tx, userId, "oauthLinked", { provider: provider.toLowerCase() }, meta.requestId);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.OAUTH_IDENTITY_IN_USE, "A provider of this type is already linked");
      throw error;
    }
  }

  async listIdentities(userId: string) {
    return this.db.externalIdentity.findMany({
      where: { userId },
      select: { id: true, provider: true, email: true, emailVerified: true, displayName: true, linkedAt: true, lastUsedAt: true },
      orderBy: { linkedAt: "asc" },
    });
  }

  async unlink(userId: string, identityId: string, meta: RequestMeta): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const identity = await tx.externalIdentity.findFirst({ where: { id: identityId, userId } });
      if (!identity) throw notFound("Identity");
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
      const identities = await tx.externalIdentity.count({ where: { userId } });
      if (!user.passwordHash && identities <= 1) throw conflict(ErrorCode.LAST_LOGIN_METHOD, "Cannot remove the last sign-in method");
      await tx.externalIdentity.delete({ where: { id: identity.id } });
      await this.audit.record({ action: "auth.oauth.unlinked", category: AuditCategory.SECURITY, actorId: userId, metadata: { provider: identity.provider }, meta }, tx);
      await this.securityNotifier.notify(tx, userId, "oauthUnlinked", { provider: identity.provider.toLowerCase() }, meta.requestId);
    });
  }
}
