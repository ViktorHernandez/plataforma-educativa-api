import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config/env.js";
import { constantTimeEqual, randomToken } from "../../core/crypto/random.js";
import { AppError, ErrorCode } from "../../core/http/errors.js";

export const REFRESH_COOKIE = "pe_rt";
export const CSRF_COOKIE = "pe_csrf";
const COOKIE_PATH = "/v1/auth";

type CookieConfig = Pick<AppConfig, "cookieSecure" | "COOKIE_DOMAIN" | "COOKIE_SAME_SITE" | "CORS_ALLOWED_ORIGINS">;

export class AuthCookies {
  constructor(private readonly config: CookieConfig) {}

  private baseOptions() {
    return {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: this.config.COOKIE_SAME_SITE,
      path: COOKIE_PATH,
      domain: this.config.COOKIE_DOMAIN || undefined,
    } as const;
  }

  issue(reply: FastifyReply, refreshToken: string, expiresAt: Date, existingCsrf?: string): string {
    const csrfToken = existingCsrf ?? randomToken(24);
    reply.setCookie(REFRESH_COOKIE, refreshToken, { ...this.baseOptions(), expires: expiresAt });
    reply.setCookie(CSRF_COOKIE, csrfToken, { ...this.baseOptions(), expires: expiresAt });
    return csrfToken;
  }

  clear(reply: FastifyReply): void {
    reply.clearCookie(REFRESH_COOKIE, this.baseOptions());
    reply.clearCookie(CSRF_COOKIE, this.baseOptions());
  }

  readRefreshToken(request: FastifyRequest): string | null {
    return request.cookies[REFRESH_COOKIE] ?? null;
  }

  readCsrf(request: FastifyRequest): string | null {
    return request.cookies[CSRF_COOKIE] ?? null;
  }

  ensureCsrf(reply: FastifyReply, request: FastifyRequest): string {
    const existing = this.readCsrf(request);
    if (existing && existing.length >= 20) return existing;
    const csrfToken = randomToken(24);
    reply.setCookie(CSRF_COOKIE, csrfToken, { ...this.baseOptions() });
    return csrfToken;
  }

  assertOriginAllowed(request: FastifyRequest): void {
    const origin = request.headers.origin;
    if (origin && !this.config.CORS_ALLOWED_ORIGINS.includes(origin)) {
      throw new AppError(403, ErrorCode.ORIGIN_NOT_ALLOWED, "Origin not allowed");
    }
  }

  assertCookieRequestIsSafe(request: FastifyRequest): void {
    this.assertOriginAllowed(request);
    const cookieValue = this.readCsrf(request);
    const headerValue = request.headers["x-csrf-token"];
    if (!cookieValue || typeof headerValue !== "string" || !constantTimeEqual(cookieValue, headerValue)) {
      throw new AppError(403, ErrorCode.CSRF_FAILED, "CSRF validation failed");
    }
  }
}
