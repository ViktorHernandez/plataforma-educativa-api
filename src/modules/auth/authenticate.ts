import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError, ErrorCode } from "../../core/http/errors.js";
import type { AuthContext } from "../../core/http/request-context.js";
import { AccessTokenError, type AccessTokenService } from "../../core/security/access-tokens.js";
import { SessionStore } from "../../core/security/session-store.js";

export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface Authenticator {
  required: PreHandler;
  optional: PreHandler;
  resolveToken(token: string): Promise<AuthContext>;
}

function unauthorizedWithChallenge(code: ErrorCode, message: string, error: "invalid_token" | "invalid_request"): AppError {
  return new AppError(401, code, message, { headers: { "www-authenticate": `Bearer error="${error}"` } });
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  if (!match) throw unauthorizedWithChallenge(ErrorCode.TOKEN_INVALID, "Malformed authorization header", "invalid_request");
  return match[1]!;
}

export function createAuthenticator(accessTokens: AccessTokenService, sessions: SessionStore): Authenticator {
  async function resolveToken(token: string): Promise<AuthContext> {
    let claims;
    try {
      claims = await accessTokens.verify(token);
    } catch (error) {
      if (error instanceof AccessTokenError && error.reason === "expired") {
        throw unauthorizedWithChallenge(ErrorCode.TOKEN_EXPIRED, "Access token expired", "invalid_token");
      }
      throw unauthorizedWithChallenge(ErrorCode.TOKEN_INVALID, "Invalid access token", "invalid_token");
    }
    const snapshot = await sessions.load(claims.sessionId);
    if (!SessionStore.isUsable(snapshot) || snapshot.userId !== claims.userId) {
      throw unauthorizedWithChallenge(ErrorCode.SESSION_REVOKED, "Session is no longer valid", "invalid_token");
    }
    void sessions.touch(claims.sessionId);
    return {
      userId: claims.userId,
      sessionId: claims.sessionId,
      mfa: snapshot.mfaVerified,
      authMethods: claims.authMethods,
      authenticatedAt: new Date(snapshot.authenticatedAt),
      tokenExpiresAt: new Date(claims.expiresAt * 1000),
    };
  }

  return {
    resolveToken,
    required: async (request) => {
      const token = bearerToken(request);
      if (!token) throw unauthorizedWithChallenge(ErrorCode.UNAUTHENTICATED, "Authentication required", "invalid_request");
      request.auth = await resolveToken(token);
    },
    optional: async (request) => {
      const token = bearerToken(request);
      if (token) request.auth = await resolveToken(token);
    },
  };
}
