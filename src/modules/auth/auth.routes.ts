import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import { AppError, ErrorCode, unauthorized } from "../../core/http/errors.js";
import { buildCursorPage, decodeCursor } from "../../core/http/pagination.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { acceptedResponse, cursorPage, cursorQuery, dataEnvelope, idParams, okResponse, standardErrors } from "../../core/http/schemas.js";
import { SessionRevocationReason } from "../../generated/prisma/enums.js";
import {
  activityItem,
  authenticatedResponse,
  emailBody,
  identityItem,
  loginBody,
  loginResponse,
  mfaChallengeBody,
  mfaConfirmBody,
  mfaDisableBody,
  mfaSetupBody,
  mfaSetupResponse,
  mfaStatusResponse,
  oauthAuthorizeQuery,
  oauthCallbackQuery,
  oauthExchangeBody,
  oauthProviderParams,
  passwordChangeBody,
  passwordResetBody,
  recoveryCodesResponse,
  recoveryRegenerateBody,
  refreshBody,
  refreshResponse,
  registerBody,
  sessionItem,
  tokenBody,
  unlinkBody,
} from "./auth.schemas.js";
import type { AuthenticatedResult, LoginResult, TokenDelivery } from "./auth.types.js";

const tags = ["Auth"];

export function registerAuthRoutes(app: AppInstance, container: Container): void {
  const { auth, mfa, oauth, sessions, authenticator, authCookies } = container;

  function presentAuthenticated(reply: FastifyReply, result: AuthenticatedResult, delivery: TokenDelivery) {
    const cookieMode = delivery === "cookie";
    const csrfToken = cookieMode ? authCookies.issue(reply, result.session.refreshToken, result.session.refreshTokenExpiresAt) : undefined;
    return {
      status: "AUTHENTICATED" as const,
      tokenType: "Bearer" as const,
      accessToken: result.session.accessToken,
      accessTokenExpiresAt: result.session.accessTokenExpiresAt,
      refreshToken: cookieMode ? undefined : result.session.refreshToken,
      refreshTokenExpiresAt: result.session.refreshTokenExpiresAt,
      csrfToken,
      sessionId: result.session.sessionId,
      user: result.user,
    };
  }

  function presentLogin(reply: FastifyReply, result: LoginResult, delivery: TokenDelivery) {
    if (result.status === "MFA_REQUIRED") return result;
    return presentAuthenticated(reply, result, delivery);
  }

  async function reauthenticate(request: FastifyRequest, reauth: { password?: string; totpCode?: string } | undefined) {
    const current = requireAuth(request);
    await auth.verifyReauthentication(current.userId, current.authenticatedAt, reauth, requestMeta(request));
  }

  app.post(
    "/auth/register",
    { schema: { tags, summary: "Register a new account", body: registerBody, response: { 202: acceptedResponse, ...standardErrors } } },
    async (request, reply) => {
      await auth.register(request.body, request.client, requestMeta(request), request.locale);
      reply.code(202);
      return { data: { accepted: true as const } };
    },
  );

  app.post(
    "/auth/email/verify",
    { schema: { tags, summary: "Confirm email ownership", body: tokenBody, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await auth.verifyEmail(request.body.token, request.client, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/auth/email/resend",
    { schema: { tags, summary: "Resend the verification email", body: emailBody, response: { 202: acceptedResponse, ...standardErrors } } },
    async (request, reply) => {
      await auth.resendVerification(request.body.email, request.client, requestMeta(request));
      reply.code(202);
      return { data: { accepted: true as const } };
    },
  );

  app.post(
    "/auth/login",
    { schema: { tags, summary: "Sign in with email and password", body: loginBody, response: { 200: loginResponse, ...standardErrors } } },
    async (request, reply) => {
      const result = await auth.login(request.body, request.client, requestMeta(request));
      return { data: presentLogin(reply, result, request.body.tokenDelivery) };
    },
  );

  app.post(
    "/auth/mfa/challenge",
    { schema: { tags, summary: "Complete a sign-in with a second factor", body: mfaChallengeBody, response: { 200: authenticatedResponse, ...standardErrors } } },
    async (request, reply) => {
      const result = await mfa.completeChallenge(request.body, request.client, requestMeta(request));
      return { data: presentAuthenticated(reply, result, request.body.tokenDelivery) };
    },
  );

  app.post(
    "/auth/refresh",
    { schema: { tags, summary: "Rotate the refresh token and issue a new access token", body: refreshBody.nullish(), response: { 200: refreshResponse, ...standardErrors } } },
    async (request, reply) => {
      const bodyToken = request.body?.refreshToken;
      let token = bodyToken ?? null;
      const cookieMode = !bodyToken;
      if (cookieMode) {
        token = authCookies.readRefreshToken(request);
        if (!token) throw unauthorized(ErrorCode.TOKEN_INVALID, "Missing refresh token");
        authCookies.assertCookieRequestIsSafe(request);
      }
      try {
        const session = await auth.refresh(token!, request.client, requestMeta(request));
        if (cookieMode) authCookies.issue(reply, session.refreshToken, session.refreshTokenExpiresAt, authCookies.readCsrf(request) ?? undefined);
        return {
          data: {
            tokenType: "Bearer" as const,
            accessToken: session.accessToken,
            accessTokenExpiresAt: session.accessTokenExpiresAt,
            refreshToken: cookieMode ? undefined : session.refreshToken,
            refreshTokenExpiresAt: session.refreshTokenExpiresAt,
            sessionId: session.sessionId,
          },
        };
      } catch (error) {
        if (cookieMode && error instanceof AppError && error.statusCode === 401) authCookies.clear(reply);
        throw error;
      }
    },
  );

  app.get(
    "/auth/csrf",
    { schema: { tags, summary: "CSRF token for browser sessions that keep the refresh token in a cookie", response: { 200: dataEnvelope(z.object({ csrfToken: z.string() })), ...standardErrors } } },
    async (request, reply) => {
      if (!authCookies.readRefreshToken(request)) throw unauthorized(ErrorCode.TOKEN_INVALID, "Missing refresh token");
      authCookies.assertOriginAllowed(request);
      return { data: { csrfToken: authCookies.ensureCsrf(reply, request) } };
    },
  );

  app.post(
    "/auth/logout",
    {
      preHandler: authenticator.optional,
      schema: { tags, summary: "Close the current session", body: refreshBody.nullish(), response: { 200: okResponse, ...standardErrors } },
    },
    async (request, reply) => {
      let target: { sessionId: string; userId: string } | null = request.auth ? { sessionId: request.auth.sessionId, userId: request.auth.userId } : null;
      if (!target) {
        const bodyToken = request.body?.refreshToken;
        const cookieToken = bodyToken ? null : authCookies.readRefreshToken(request);
        if (cookieToken) authCookies.assertCookieRequestIsSafe(request);
        const token = bodyToken ?? cookieToken;
        target = token ? await sessions.findSessionIdByRefreshToken(token) : null;
      }
      if (target) await auth.logout(target.sessionId, target.userId, requestMeta(request));
      authCookies.clear(reply);
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/auth/password/forgot",
    { schema: { tags, summary: "Request a password reset email", body: emailBody, response: { 202: acceptedResponse, ...standardErrors } } },
    async (request, reply) => {
      await auth.forgotPassword(request.body.email, request.client, requestMeta(request));
      reply.code(202);
      return { data: { accepted: true as const } };
    },
  );

  app.post(
    "/auth/password/reset",
    { schema: { tags, summary: "Set a new password with a reset token", body: passwordResetBody, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await auth.resetPassword(request.body.token, request.body.newPassword, request.client, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/auth/password/setup",
    { schema: { tags, summary: "Create the first password of an invited account", body: passwordResetBody, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await auth.setupAccount(request.body.token, request.body.newPassword, request.client, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/auth/password/change",
    {
      preHandler: authenticator.required,
      schema: { tags, summary: "Change the password of the current user", security: [{ bearerAuth: [] }], body: passwordChangeBody, response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      const current = requireAuth(request);
      await auth.changePassword(current.userId, current.sessionId, request.body.currentPassword, request.body.newPassword, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.get(
    "/auth/sessions",
    {
      preHandler: authenticator.required,
      schema: { tags, summary: "List sessions of the current user", security: [{ bearerAuth: [] }], response: { 200: dataEnvelope(z.array(sessionItem)), ...standardErrors } },
    },
    async (request) => {
      const current = requireAuth(request);
      return { data: await sessions.list(current.userId, current.sessionId) };
    },
  );

  app.delete(
    "/auth/sessions/:id",
    {
      preHandler: authenticator.required,
      schema: { tags, summary: "Revoke a session", security: [{ bearerAuth: [] }], params: idParams, response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      const current = requireAuth(request);
      await sessions.revokeForUser(current.userId, request.params.id, SessionRevocationReason.USER_REVOKED);
      await container.audit.record({ action: "auth.session.revoked", category: AuditCategory.SECURITY, actorId: current.userId, resourceType: "session", resourceId: request.params.id, meta: requestMeta(request) });
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/auth/sessions/revoke-others",
    {
      preHandler: authenticator.required,
      schema: { tags, summary: "Revoke every other session", security: [{ bearerAuth: [] }], response: { 200: dataEnvelope(z.object({ revoked: z.number().int() })), ...standardErrors } },
    },
    async (request) => {
      const current = requireAuth(request);
      const revoked = await sessions.revokeAll(current.userId, SessionRevocationReason.USER_REVOKED, current.sessionId);
      await container.audit.record({ action: "auth.session.revoked_others", category: AuditCategory.SECURITY, actorId: current.userId, metadata: { revoked }, meta: requestMeta(request) });
      return { data: { revoked } };
    },
  );

  app.get(
    "/auth/activity",
    {
      preHandler: authenticator.required,
      schema: { tags, summary: "Security activity of the current user", security: [{ bearerAuth: [] }], querystring: cursorQuery, response: { 200: cursorPage(activityItem), ...standardErrors } },
    },
    async (request) => {
      const current = requireAuth(request);
      const cursor = decodeCursor(request.query.cursor);
      const rows = await container.db.auditLog.findMany({
        where: { actorId: current.userId, category: AuditCategory.SECURITY, ...(cursor ? { id: { lt: cursor.id } } : {}) },
        orderBy: { id: "desc" },
        take: request.query.limit + 1,
        select: { id: true, action: true, outcome: true, ipAddress: true, userAgent: true, occurredAt: true },
      });
      return buildCursorPage(rows, request.query.limit);
    },
  );

  app.get(
    "/auth/mfa",
    { preHandler: authenticator.required, schema: { tags, summary: "Two-factor status", security: [{ bearerAuth: [] }], response: { 200: mfaStatusResponse, ...standardErrors } } },
    async (request) => ({ data: await mfa.status(requireAuth(request).userId) }),
  );

  app.post(
    "/auth/mfa/totp/setup",
    {
      preHandler: authenticator.required,
      schema: { tags, summary: "Start TOTP enrollment", security: [{ bearerAuth: [] }], body: mfaSetupBody, response: { 200: mfaSetupResponse, ...standardErrors } },
    },
    async (request) => {
      await reauthenticate(request, request.body.reauth);
      return { data: await mfa.beginTotpSetup(requireAuth(request).userId, requestMeta(request)) };
    },
  );

  app.post(
    "/auth/mfa/totp/confirm",
    {
      preHandler: authenticator.required,
      schema: { tags, summary: "Confirm TOTP enrollment and receive recovery codes", security: [{ bearerAuth: [] }], body: mfaConfirmBody, response: { 200: recoveryCodesResponse, ...standardErrors } },
    },
    async (request) => {
      const current = requireAuth(request);
      return { data: await mfa.confirmTotp(current.userId, current.sessionId, request.body.code, requestMeta(request)) };
    },
  );

  app.post(
    "/auth/mfa/totp/disable",
    {
      preHandler: authenticator.required,
      schema: { tags, summary: "Disable two-factor authentication", security: [{ bearerAuth: [] }], body: mfaDisableBody, response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      await reauthenticate(request, request.body.reauth);
      await mfa.disable(requireAuth(request).userId, { code: request.body.code, recoveryCode: request.body.recoveryCode }, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/auth/mfa/recovery-codes",
    {
      preHandler: authenticator.required,
      schema: { tags, summary: "Regenerate recovery codes", security: [{ bearerAuth: [] }], body: recoveryRegenerateBody, response: { 200: recoveryCodesResponse, ...standardErrors } },
    },
    async (request) => {
      await reauthenticate(request, request.body.reauth);
      return { data: await mfa.regenerateRecoveryCodes(requireAuth(request).userId, { code: request.body.code }, requestMeta(request)) };
    },
  );

  app.get(
    "/auth/oauth/providers",
    { schema: { tags, summary: "Enabled external sign-in providers", response: { 200: dataEnvelope(z.array(z.string())) } } },
    async () => ({ data: oauth.providers() }),
  );

  app.get(
    "/auth/oauth/:provider/authorize",
    {
      preHandler: authenticator.optional,
      schema: {
        tags,
        summary: "Create an authorization URL for an external provider",
        params: oauthProviderParams,
        querystring: oauthAuthorizeQuery,
        response: { 200: dataEnvelope(z.object({ authorizationUrl: z.string(), expiresAt: z.iso.datetime() })), ...standardErrors },
      },
    },
    async (request) => {
      if (request.query.intent === "link") {
        const current = requireAuth(request);
        await reauthenticateForLink(request, current.userId);
      }
      const result = await oauth.authorize(
        {
          provider: request.params.provider,
          redirectUri: request.query.redirectUri,
          codeChallenge: request.query.codeChallenge,
          intent: request.query.intent,
          userId: request.auth?.userId ?? null,
          locale: request.locale,
        },
        request.client,
      );
      return { data: { authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt.toISOString() } };
    },
  );

  async function reauthenticateForLink(request: FastifyRequest, userId: string) {
    const current = requireAuth(request);
    if (Date.now() - current.authenticatedAt.getTime() > 15 * 60 * 1000) {
      await container.audit.record({ action: "auth.oauth.link_stale_session", category: AuditCategory.SECURITY, actorId: userId, meta: requestMeta(request) });
      throw new AppError(403, ErrorCode.REAUTHENTICATION_REQUIRED, "Sign in again before linking a provider");
    }
  }

  app.get(
    "/auth/oauth/:provider/callback",
    { schema: { tags, summary: "OAuth redirect endpoint used by providers", params: oauthProviderParams, querystring: oauthCallbackQuery } },
    async (request, reply) => {
      const outcome = await oauth.handleCallback(request.params.provider, request.query, request.client, requestMeta(request));
      reply.header("referrer-policy", "no-referrer");
      return reply.redirect(outcome.redirectTo, 302);
    },
  );

  app.post(
    "/auth/oauth/exchange",
    { schema: { tags, summary: "Exchange the one-time OAuth code for a session", body: oauthExchangeBody, response: { 200: loginResponse, ...standardErrors } } },
    async (request, reply) => {
      const result = await oauth.exchange(request.body, request.client, requestMeta(request));
      return { data: presentLogin(reply, result, request.body.tokenDelivery) };
    },
  );

  app.get(
    "/auth/identities",
    { preHandler: authenticator.required, schema: { tags, summary: "Linked external identities", security: [{ bearerAuth: [] }], response: { 200: dataEnvelope(z.array(identityItem)), ...standardErrors } } },
    async (request) => ({ data: await oauth.listIdentities(requireAuth(request).userId) }),
  );

  app.post(
    "/auth/identities/:id/unlink",
    {
      preHandler: authenticator.required,
      schema: { tags, summary: "Unlink an external identity", security: [{ bearerAuth: [] }], params: idParams, body: unlinkBody, response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      await reauthenticate(request, request.body.reauth);
      await oauth.unlink(requireAuth(request).userId, request.params.id, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );
}

export function registerWellKnownRoutes(app: AppInstance, container: Container): void {
  app.get(
    "/.well-known/jwks.json",
    { schema: { tags: ["Auth"], summary: "Public keys used to sign access tokens", response: { 200: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }) } } },
    async (_request, reply) => {
      reply.header("cache-control", "public, max-age=300");
      return container.accessTokens.jwks();
    },
  );
}
