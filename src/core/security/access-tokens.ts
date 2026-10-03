import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { errors as joseErrors, exportJWK, jwtVerify, SignJWT, type JWK } from "jose";
import type { KeyringEntry } from "../../config/env.js";
import { randomToken } from "../crypto/random.js";

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
  authMethods: string[];
  mfa: boolean;
  issuedAt: number;
  expiresAt: number;
  tokenId: string;
}

interface SigningKey {
  id: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export class AccessTokenError extends Error {
  constructor(
    readonly reason: "expired" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

const ALGORITHM = "EdDSA";
const TOKEN_TYPE = "at+jwt";

export class AccessTokenService {
  private readonly keys: SigningKey[];

  constructor(
    entries: KeyringEntry[],
    private readonly issuer: string,
    private readonly audience: string,
    private readonly ttlSeconds: number,
  ) {
    this.keys = entries.map((entry) => {
      const privateKey = createPrivateKey({ key: Buffer.from(entry.material, "base64"), format: "der", type: "pkcs8" });
      if (privateKey.asymmetricKeyType !== "ed25519") {
        throw new Error(`JWT key ${entry.id} must be an Ed25519 private key`);
      }
      return { id: entry.id, privateKey, publicKey: createPublicKey(privateKey) };
    });
  }

  get accessTokenTtlSeconds(): number {
    return this.ttlSeconds;
  }

  async sign(input: { userId: string; sessionId: string; authMethods: string[]; mfa: boolean }): Promise<{ token: string; expiresAt: Date }> {
    const active = this.keys[0]!;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + this.ttlSeconds;
    const token = await new SignJWT({ sid: input.sessionId, amr: input.authMethods, mfa: input.mfa })
      .setProtectedHeader({ alg: ALGORITHM, kid: active.id, typ: TOKEN_TYPE })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(input.userId)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(expiresAt)
      .setJti(randomToken(16))
      .sign(active.privateKey);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          const key = this.keys.find((candidate) => candidate.id === header.kid);
          if (!key) throw new AccessTokenError("invalid", "Unknown signing key");
          return key.publicKey;
        },
        {
          issuer: this.issuer,
          audience: this.audience,
          algorithms: [ALGORITHM],
          typ: TOKEN_TYPE,
          clockTolerance: 5,
          requiredClaims: ["sub", "sid", "exp", "iat", "jti"],
        },
      );
      const sessionId = payload["sid"];
      const amr = payload["amr"];
      if (typeof payload.sub !== "string" || typeof sessionId !== "string" || !Array.isArray(amr)) {
        throw new AccessTokenError("invalid", "Malformed claims");
      }
      return {
        userId: payload.sub,
        sessionId,
        authMethods: amr.filter((item): item is string => typeof item === "string"),
        mfa: payload["mfa"] === true,
        issuedAt: payload.iat!,
        expiresAt: payload.exp!,
        tokenId: payload.jti!,
      };
    } catch (error) {
      if (error instanceof AccessTokenError) throw error;
      if (error instanceof joseErrors.JWTExpired) throw new AccessTokenError("expired", "Token expired");
      throw new AccessTokenError("invalid", "Token verification failed");
    }
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    const keys = await Promise.all(
      this.keys.map(async (key) => ({ ...(await exportJWK(key.publicKey)), kid: key.id, alg: ALGORITHM, use: "sig" })),
    );
    return { keys };
  }
}
