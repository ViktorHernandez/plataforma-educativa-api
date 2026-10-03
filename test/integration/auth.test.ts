import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateTotp } from "../../src/core/security/totp.js";
import { UserStatus } from "../../src/generated/prisma/enums.js";
import { bearer, createUser, createUserWithSession, DEFAULT_PASSWORD, login, uniqueEmail } from "../helpers/factories.js";
import { createTestContext, extractToken, json, resetState, type TestContext } from "../helpers/test-app.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetState(ctx.container);
  ctx.mail.clear();
});

describe("registration and email verification", () => {
  it("registers, requires verification and then allows login", async () => {
    const email = uniqueEmail("register");
    const register = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password: DEFAULT_PASSWORD, displayName: "Ana Pérez", acceptTerms: true, timezone: "America/Mexico_City" },
    });
    expect(register.statusCode).toBe(202);

    const beforeVerification = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: DEFAULT_PASSWORD } });
    expect(beforeVerification.statusCode).toBe(403);
    expect(json(beforeVerification).error.code).toBe("EMAIL_NOT_VERIFIED");

    await ctx.outbox.drain();
    const token = extractToken(ctx.mail, email, "/verify-email");
    const verify = await ctx.app.inject({ method: "POST", url: "/v1/auth/email/verify", payload: { token } });
    expect(verify.statusCode).toBe(200);

    const reuse = await ctx.app.inject({ method: "POST", url: "/v1/auth/email/verify", payload: { token } });
    expect(reuse.statusCode).toBe(400);
    expect(json(reuse).error.code).toBe("TOKEN_ALREADY_USED");

    const session = await login(ctx.app, email);
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
  });

  it("does not reveal existing accounts and notifies the owner instead", async () => {
    const existing = await createUser(ctx.container);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: existing.email, password: "Another-Strong-Pass-99", displayName: "Intruder", acceptTerms: true },
    });
    expect(response.statusCode).toBe(202);
    await ctx.outbox.drain();
    const sent = ctx.mail.sent.filter((message) => message.to === existing.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.tags?.["template"]).toBe("account-exists");
    const stillOriginal = await login(ctx.app, existing.email);
    expect(stillOriginal.accessToken).toBeTruthy();
  });

  it("rejects weak passwords with policy details", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: uniqueEmail(), password: "short", displayName: "Weak", acceptTerms: true },
    });
    expect(response.statusCode).toBe(422);
    const body = json(response);
    expect(body.error.code).toBe("PASSWORD_POLICY");
    expect(body.error.details.issues).toContain("TOO_SHORT");
  });

  it("rejects unknown fields to prevent mass assignment", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: uniqueEmail(), password: DEFAULT_PASSWORD, displayName: "X Y", acceptTerms: true, status: "ACTIVE", role: "platform_admin" },
    });
    expect(response.statusCode).toBe(400);
    expect(json(response).error.code).toBe("VALIDATION_FAILED");
  });
});

describe("login protections", () => {
  it("returns the same error for unknown accounts and wrong passwords", async () => {
    const user = await createUser(ctx.container);
    const wrong = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: "Wrong-Password-123" } });
    const unknown = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: uniqueEmail("ghost"), password: "Wrong-Password-123" } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(json(wrong).error.code).toBe("INVALID_CREDENTIALS");
    expect(json(unknown).error.code).toBe("INVALID_CREDENTIALS");
    expect(json(wrong).error.message).toBe(json(unknown).error.message);
  });

  it("blocks brute force attempts against one account", async () => {
    const user = await createUser(ctx.container);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: `Wrong-${attempt}-Password` } });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: DEFAULT_PASSWORD } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(json(blocked).error.code).toBe("RATE_LIMITED");
  });

  it("denies suspended accounts", async () => {
    const user = await createUser(ctx.container, { status: UserStatus.SUSPENDED });
    const response = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: DEFAULT_PASSWORD } });
    expect(response.statusCode).toBe(403);
    expect(json(response).error.code).toBe("ACCOUNT_SUSPENDED");
  });

  it("records failed logins in the audit log without secrets", async () => {
    const user = await createUser(ctx.container);
    await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: "Wrong-Password-000" } });
    const entries = await ctx.container.db.auditLog.findMany({ where: { action: "auth.login.failed" } });
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).not.toContain("Wrong-Password-000");
  });
});

describe("tokens and sessions", () => {
  it("rejects missing, malformed, invalid and foreign tokens", async () => {
    const missing = await ctx.app.inject({ method: "GET", url: "/v1/auth/sessions" });
    expect(missing.statusCode).toBe(401);
    expect(json(missing).error.code).toBe("UNAUTHENTICATED");

    const malformed = await ctx.app.inject({ method: "GET", url: "/v1/auth/sessions", headers: { authorization: "Basic abc" } });
    expect(malformed.statusCode).toBe(401);

    const invalid = await ctx.app.inject({ method: "GET", url: "/v1/auth/sessions", headers: bearer("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.") });
    expect(invalid.statusCode).toBe(401);
    expect(json(invalid).error.code).toBe("TOKEN_INVALID");
  });

  it("rejects expired access tokens", async () => {
    const expiredCtx = await createTestContext({ env: { ACCESS_TOKEN_TTL_SECONDS: "60" } });
    try {
      const user = await createUser(expiredCtx.container);
      const session = await login(expiredCtx.app, user.email);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 10 * 60 * 1000));
      try {
        const response = await expiredCtx.app.inject({ method: "GET", url: "/v1/auth/sessions", headers: bearer(session.accessToken) });
        expect(response.statusCode).toBe(401);
        expect(json(response).error.code).toBe("TOKEN_EXPIRED");
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await expiredCtx.close();
    }
  });

  it("rotates refresh tokens and tolerates concurrent reuse within the grace window", async () => {
    const { refreshToken } = await createUserWithSession(ctx.app, ctx.container);
    const first = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken } });
    expect(first.statusCode).toBe(200);
    const rotated = json(first).data;
    expect(rotated.refreshToken).not.toBe(refreshToken);

    const concurrent = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken } });
    expect(concurrent.statusCode).toBe(409);
    expect(json(concurrent).error.code).toBe("REFRESH_TOKEN_ROTATED");

    const next = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: rotated.refreshToken } });
    expect(next.statusCode).toBe(200);
  });

  it("revokes the whole session when a rotated refresh token is replayed", async () => {
    const strict = await createTestContext({ env: { REFRESH_REUSE_GRACE_SECONDS: "0" } });
    try {
      await resetState(strict.container);
      const { refreshToken, accessToken, user } = await createUserWithSession(strict.app, strict.container);
      const first = await strict.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken } });
      expect(first.statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const replay = await strict.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken } });
      expect(replay.statusCode).toBe(401);
      expect(json(replay).error.code).toBe("SESSION_REVOKED");

      const newAccess = json(first).data.accessToken as string;
      for (const token of [accessToken, newAccess]) {
        const denied = await strict.app.inject({ method: "GET", url: "/v1/auth/sessions", headers: bearer(token) });
        expect(denied.statusCode).toBe(401);
        expect(json(denied).error.code).toBe("SESSION_REVOKED");
      }
      const rotatedRefresh = await strict.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: json(first).data.refreshToken } });
      expect(rotatedRefresh.statusCode).toBe(401);

      const alert = await strict.container.db.auditLog.findFirst({ where: { action: "auth.refresh.reuse_detected", actorId: user.id } });
      expect(alert).not.toBeNull();
      await strict.outbox.drain();
      expect(strict.mail.sent.some((message) => message.to === user.email && message.tags?.["template"] === "security-alert")).toBe(true);
    } finally {
      await strict.close();
    }
  });

  it("logs out and invalidates the access token immediately", async () => {
    const { headers } = await createUserWithSession(ctx.app, ctx.container);
    const before = await ctx.app.inject({ method: "GET", url: "/v1/auth/sessions", headers });
    expect(before.statusCode).toBe(200);
    const logout = await ctx.app.inject({ method: "POST", url: "/v1/auth/logout", headers });
    expect(logout.statusCode).toBe(200);
    const after = await ctx.app.inject({ method: "GET", url: "/v1/auth/sessions", headers });
    expect(after.statusCode).toBe(401);
    expect(json(after).error.code).toBe("SESSION_REVOKED");
  });

  it("revokes another session remotely and forbids touching sessions of other users", async () => {
    const user = await createUser(ctx.container);
    const phone = await login(ctx.app, user.email, DEFAULT_PASSWORD, { "x-client-platform": "android", "x-device-id": "device-phone-000000001" });
    const laptop = await login(ctx.app, user.email, DEFAULT_PASSWORD, { "x-client-platform": "windows", "x-device-id": "device-laptop-00000001" });
    const other = await createUserWithSession(ctx.app, ctx.container);

    const foreign = await ctx.app.inject({ method: "DELETE", url: `/v1/auth/sessions/${phone.sessionId}`, headers: other.headers });
    expect(foreign.statusCode).toBe(404);

    const list = await ctx.app.inject({ method: "GET", url: "/v1/auth/sessions", headers: bearer(laptop.accessToken) });
    const sessions = json(list).data;
    expect(sessions).toHaveLength(2);
    expect(sessions.find((item: { current: boolean }) => item.current).id).toBe(laptop.sessionId);

    const revoke = await ctx.app.inject({ method: "DELETE", url: `/v1/auth/sessions/${phone.sessionId}`, headers: bearer(laptop.accessToken) });
    expect(revoke.statusCode).toBe(200);
    const phoneRequest = await ctx.app.inject({ method: "GET", url: "/v1/auth/sessions", headers: bearer(phone.accessToken) });
    expect(phoneRequest.statusCode).toBe(401);
  });

  it("alerts the user about sign-ins from new devices", async () => {
    const user = await createUser(ctx.container);
    await login(ctx.app, user.email, DEFAULT_PASSWORD, { "x-device-id": "device-first-0000000001" });
    await login(ctx.app, user.email, DEFAULT_PASSWORD, { "x-device-id": "device-second-000000001", "x-device-name": "Pixel 9" });
    await ctx.outbox.drain();
    const alerts = ctx.mail.sent.filter((message) => message.to === user.email && message.tags?.["template"] === "new-login");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain("Pixel 9");
  });
});

describe("password recovery and change", () => {
  it("resets the password with a single-use token and revokes sessions", async () => {
    const { user, headers } = await createUserWithSession(ctx.app, ctx.container);
    const forgot = await ctx.app.inject({ method: "POST", url: "/v1/auth/password/forgot", payload: { email: user.email } });
    expect(forgot.statusCode).toBe(202);
    const unknown = await ctx.app.inject({ method: "POST", url: "/v1/auth/password/forgot", payload: { email: uniqueEmail("nobody") } });
    expect(unknown.statusCode).toBe(202);
    await ctx.outbox.drain();
    const token = extractToken(ctx.mail, user.email, "/reset-password");
    const newPassword = "Brand-New-Secret-2026";
    const reset = await ctx.app.inject({ method: "POST", url: "/v1/auth/password/reset", payload: { token, newPassword } });
    expect(reset.statusCode).toBe(200);
    const replay = await ctx.app.inject({ method: "POST", url: "/v1/auth/password/reset", payload: { token, newPassword: "Other-Secret-2026-x" } });
    expect(replay.statusCode).toBe(400);
    const oldSession = await ctx.app.inject({ method: "GET", url: "/v1/auth/sessions", headers });
    expect(oldSession.statusCode).toBe(401);
    await expect(login(ctx.app, user.email, DEFAULT_PASSWORD)).rejects.toThrow();
    expect((await login(ctx.app, user.email, newPassword)).accessToken).toBeTruthy();
  });

  it("changes the password keeping only the current session", async () => {
    const user = await createUser(ctx.container);
    const current = await login(ctx.app, user.email, DEFAULT_PASSWORD, { "x-device-id": "device-current-000001" });
    const other = await login(ctx.app, user.email, DEFAULT_PASSWORD, { "x-device-id": "device-other-00000001" });
    const wrongCurrent = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/password/change",
      headers: bearer(current.accessToken),
      payload: { currentPassword: "Not-The-Password-1", newPassword: "Changed-Password-2026" },
    });
    expect(wrongCurrent.statusCode).toBe(403);
    const change = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/password/change",
      headers: bearer(current.accessToken),
      payload: { currentPassword: DEFAULT_PASSWORD, newPassword: "Changed-Password-2026" },
    });
    expect(change.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/v1/auth/sessions", headers: bearer(current.accessToken) })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/v1/auth/sessions", headers: bearer(other.accessToken) })).statusCode).toBe(401);
  });
});

describe("two-factor authentication", () => {
  async function enableTotp(headers: Record<string, string>) {
    const setup = await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/totp/setup", headers, payload: { reauth: { password: DEFAULT_PASSWORD } } });
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUri, qrCodeDataUrl } = json(setup).data;
    expect(otpauthUri).toContain("otpauth://totp/");
    expect(qrCodeDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    const confirm = await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", headers, payload: { code: generateTotp(secret) } });
    expect(confirm.statusCode).toBe(200);
    return { secret: secret as string, recoveryCodes: json(confirm).data.recoveryCodes as string[] };
  }

  it("requires reauthentication before starting enrollment", async () => {
    const { headers } = await createUserWithSession(ctx.app, ctx.container);
    const response = await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/totp/setup", headers, payload: { reauth: { password: "Wrong-Password-111" } } });
    expect(response.statusCode).toBe(403);
    expect(json(response).error.code).toBe("REAUTHENTICATION_REQUIRED");
  });

  it("stores the TOTP secret encrypted", async () => {
    const { headers, user } = await createUserWithSession(ctx.app, ctx.container);
    const { secret } = await enableTotp(headers);
    const factor = await ctx.container.db.mfaFactor.findFirstOrThrow({ where: { userId: user.id } });
    expect(factor.secretCiphertext).not.toContain(secret);
    expect(factor.secretCiphertext.startsWith("v1.")).toBe(true);
  });

  it("challenges sign-ins, rejects replayed codes and accepts recovery codes once", async () => {
    const { headers, user } = await createUserWithSession(ctx.app, ctx.container);
    const { secret, recoveryCodes } = await enableTotp(headers);
    expect(recoveryCodes).toHaveLength(10);

    const first = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: DEFAULT_PASSWORD } });
    expect(json(first).data.status).toBe("MFA_REQUIRED");
    const challengeToken = json(first).data.challengeToken as string;

    const wrong = await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/challenge", payload: { challengeToken, code: "000000" } });
    expect(wrong.statusCode).toBe(401);

    const replayedCode = generateTotp(secret);
    const replay = await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/challenge", payload: { challengeToken, code: replayedCode } });
    expect(replay.statusCode).toBe(401);

    const withRecovery = await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/challenge", payload: { challengeToken, recoveryCode: recoveryCodes[0] } });
    expect(withRecovery.statusCode).toBe(200);
    expect(json(withRecovery).data.status).toBe("AUTHENTICATED");

    const reusedChallenge = await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/challenge", payload: { challengeToken, recoveryCode: recoveryCodes[1] } });
    expect(reusedChallenge.statusCode).toBe(401);

    const second = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: DEFAULT_PASSWORD } });
    const reusedRecovery = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/mfa/challenge",
      payload: { challengeToken: json(second).data.challengeToken, recoveryCode: recoveryCodes[0] },
    });
    expect(reusedRecovery.statusCode).toBe(401);
  });

  it("locks a challenge after too many attempts", async () => {
    const { headers, user } = await createUserWithSession(ctx.app, ctx.container);
    const { secret } = await enableTotp(headers);
    const login = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: DEFAULT_PASSWORD } });
    const challengeToken = json(login).data.challengeToken as string;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/challenge", payload: { challengeToken, code: "123456" } });
    }
    const locked = await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/challenge", payload: { challengeToken, code: generateTotp(secret, new Date(Date.now() + 30_000)) } });
    expect(locked.statusCode).toBe(401);
    expect(json(locked).error.code).toBe("TOKEN_INVALID");
  });
});

describe("cookie based sessions for browsers", () => {
  it("issues httpOnly cookies and enforces CSRF and origin checks on refresh", async () => {
    const user = await createUser(ctx.container);
    const response = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: DEFAULT_PASSWORD, tokenDelivery: "cookie" } });
    expect(response.statusCode).toBe(200);
    const body = json(response).data;
    expect(body.refreshToken).toBeUndefined();
    expect(body.csrfToken).toBeTruthy();
    const cookies = response.cookies;
    const refreshCookie = cookies.find((cookie) => cookie.name === "pe_rt")!;
    const csrfCookie = cookies.find((cookie) => cookie.name === "pe_csrf")!;
    expect(refreshCookie.httpOnly).toBe(true);
    expect(refreshCookie.sameSite).toBe("Strict");
    expect(refreshCookie.path).toBe("/v1/auth");

    const cookieHeader = `pe_rt=${refreshCookie.value}; pe_csrf=${csrfCookie.value}`;
    const noCsrf = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { cookie: cookieHeader } });
    expect(noCsrf.statusCode).toBe(403);
    expect(json(noCsrf).error.code).toBe("CSRF_FAILED");

    const badOrigin = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: cookieHeader, "x-csrf-token": body.csrfToken, origin: "https://evil.example" },
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(json(badOrigin).error.code).toBe("ORIGIN_NOT_ALLOWED");

    const ok = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: cookieHeader, "x-csrf-token": body.csrfToken, origin: "http://app.test.local" },
    });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).data.refreshToken).toBeUndefined();
    expect(ok.cookies.find((cookie) => cookie.name === "pe_rt")!.value).not.toBe(refreshCookie.value);
  });
});

describe("cross-cutting HTTP security", () => {
  it("sets security headers and request ids", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/health/live" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("only allows configured CORS origins", async () => {
    const allowed = await ctx.app.inject({
      method: "OPTIONS",
      url: "/v1/auth/login",
      headers: { origin: "http://app.test.local", "access-control-request-method": "POST" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://app.test.local");
    const denied = await ctx.app.inject({
      method: "OPTIONS",
      url: "/v1/auth/login",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects prototype pollution payloads and oversized bodies", async () => {
    const polluted = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: '{"email":"a@b.co","password":"x","__proto__":{"admin":true}}',
    });
    expect(polluted.statusCode).toBe(400);
    const huge = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "a@b.co", password: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(huge.statusCode).toBe(413);
  });

  it("does not store auth responses in caches", async () => {
    const user = await createUser(ctx.container);
    const response = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: DEFAULT_PASSWORD } });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("publishes JWKS for token verification by other services", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    expect(response.statusCode).toBe(200);
    const key = json(response).keys[0];
    expect(key.kty).toBe("OKP");
    expect(key.d).toBeUndefined();
  });
});
