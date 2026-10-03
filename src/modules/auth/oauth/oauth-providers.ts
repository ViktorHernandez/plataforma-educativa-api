import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { OAuthProvider } from "../../../generated/prisma/enums.js";

export interface ExternalProfile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

export interface AuthorizationRequest {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface CodeExchangeRequest {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  nonce: string;
}

export interface OAuthProviderAdapter {
  readonly id: OAuthProvider;
  readonly slug: string;
  buildAuthorizationUrl(request: AuthorizationRequest): string;
  exchange(request: CodeExchangeRequest): Promise<ExternalProfile>;
}

export class OAuthProviderError extends Error {}

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

async function postForm(fetchImpl: typeof fetch, url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload["error"] === "string") {
    throw new OAuthProviderError(`Token exchange failed with status ${response.status}`);
  }
  return payload;
}

abstract class OidcProviderAdapter implements OAuthProviderAdapter {
  abstract readonly id: OAuthProvider;
  abstract readonly slug: string;
  protected abstract readonly authorizationEndpoint: string;
  protected abstract readonly tokenEndpoint: string;
  protected abstract readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  protected readonly scopes = "openid email profile";

  constructor(
    protected readonly credentials: ClientCredentials,
    protected readonly fetchImpl: typeof fetch,
  ) {}

  buildAuthorizationUrl(request: AuthorizationRequest): string {
    const url = new URL(this.authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: this.credentials.clientId,
      response_type: "code",
      redirect_uri: request.redirectUri,
      scope: this.scopes,
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return url.toString();
  }

  protected abstract validateIssuer(payload: JWTPayload): boolean;
  protected abstract toProfile(payload: JWTPayload): ExternalProfile;

  async exchange(request: CodeExchangeRequest): Promise<ExternalProfile> {
    const tokens = await postForm(this.fetchImpl, this.tokenEndpoint, {
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      code_verifier: request.codeVerifier,
    });
    const idToken = tokens["id_token"];
    if (typeof idToken !== "string") throw new OAuthProviderError("Missing id_token");
    const unverified = decodeJwt(idToken);
    if (!this.validateIssuer(unverified)) throw new OAuthProviderError("Unexpected issuer");
    const { payload } = await jwtVerify(idToken, this.jwks, {
      audience: this.credentials.clientId,
      issuer: unverified.iss,
      clockTolerance: 30,
    });
    if (payload["nonce"] !== request.nonce) throw new OAuthProviderError("Nonce mismatch");
    if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new OAuthProviderError("Missing subject");
    return this.toProfile(payload);
  }
}

export class GoogleOAuthAdapter extends OidcProviderAdapter {
  readonly id = OAuthProvider.GOOGLE;
  readonly slug = "google";
  protected readonly authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
  protected readonly tokenEndpoint = "https://oauth2.googleapis.com/token";
  protected readonly jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

  protected validateIssuer(payload: JWTPayload): boolean {
    return payload.iss === "https://accounts.google.com" || payload.iss === "accounts.google.com";
  }

  protected toProfile(payload: JWTPayload): ExternalProfile {
    return {
      subject: payload.sub!,
      email: typeof payload["email"] === "string" ? payload["email"].toLowerCase() : null,
      emailVerified: payload["email_verified"] === true,
      displayName: typeof payload["name"] === "string" ? payload["name"] : null,
    };
  }
}

export class MicrosoftOAuthAdapter extends OidcProviderAdapter {
  readonly id = OAuthProvider.MICROSOFT;
  readonly slug = "microsoft";
  protected readonly authorizationEndpoint: string;
  protected readonly tokenEndpoint: string;
  protected readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(credentials: ClientCredentials, fetchImpl: typeof fetch, tenant: string) {
    super(credentials, fetchImpl);
    const base = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}`;
    this.authorizationEndpoint = `${base}/oauth2/v2.0/authorize`;
    this.tokenEndpoint = `${base}/oauth2/v2.0/token`;
    this.jwks = createRemoteJWKSet(new URL(`${base}/discovery/v2.0/keys`));
  }

  protected validateIssuer(payload: JWTPayload): boolean {
    const tenantId = payload["tid"];
    return typeof tenantId === "string" && payload.iss === `https://login.microsoftonline.com/${tenantId}/v2.0`;
  }

  protected toProfile(payload: JWTPayload): ExternalProfile {
    const email = typeof payload["email"] === "string" ? payload["email"] : typeof payload["preferred_username"] === "string" ? payload["preferred_username"] : null;
    return {
      subject: `${String(payload["tid"])}:${payload.sub!}`,
      email: email && email.includes("@") ? email.toLowerCase() : null,
      emailVerified: payload["xms_edov"] === true || payload["xms_edov"] === "1",
      displayName: typeof payload["name"] === "string" ? payload["name"] : null,
    };
  }
}

export class GitHubOAuthAdapter implements OAuthProviderAdapter {
  readonly id = OAuthProvider.GITHUB;
  readonly slug = "github";

  constructor(
    private readonly credentials: ClientCredentials,
    private readonly fetchImpl: typeof fetch,
  ) {}

  buildAuthorizationUrl(request: AuthorizationRequest): string {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: this.credentials.clientId,
      redirect_uri: request.redirectUri,
      scope: "read:user user:email",
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      allow_signup: "true",
    }).toString();
    return url.toString();
  }

  private async getJson(url: string, token: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "plataforma-educativa-api" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new OAuthProviderError(`GitHub API responded ${response.status}`);
    return response.json();
  }

  async exchange(request: CodeExchangeRequest): Promise<ExternalProfile> {
    const tokens = await postForm(this.fetchImpl, "https://github.com/login/oauth/access_token", {
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      code: request.code,
      redirect_uri: request.redirectUri,
      code_verifier: request.codeVerifier,
    });
    const accessToken = tokens["access_token"];
    if (typeof accessToken !== "string") throw new OAuthProviderError("Missing access token");
    const user = (await this.getJson("https://api.github.com/user", accessToken)) as { id?: number; name?: string | null; login?: string };
    const emails = (await this.getJson("https://api.github.com/user/emails", accessToken)) as Array<{ email: string; primary: boolean; verified: boolean }>;
    if (typeof user.id !== "number") throw new OAuthProviderError("Missing GitHub user id");
    const primary = Array.isArray(emails) ? emails.find((item) => item.primary && item.verified) : undefined;
    return {
      subject: String(user.id),
      email: primary?.email.toLowerCase() ?? null,
      emailVerified: Boolean(primary),
      displayName: user.name ?? user.login ?? null,
    };
  }
}

export class OAuthProviderRegistry {
  private readonly adapters = new Map<string, OAuthProviderAdapter>();

  register(adapter: OAuthProviderAdapter): void {
    this.adapters.set(adapter.slug, adapter);
  }

  get(slug: string): OAuthProviderAdapter | undefined {
    return this.adapters.get(slug);
  }

  enabled(): string[] {
    return [...this.adapters.keys()];
  }
}

export function buildOAuthRegistry(
  config: {
    OAUTH_GOOGLE_CLIENT_ID?: string;
    OAUTH_GOOGLE_CLIENT_SECRET?: string;
    OAUTH_MICROSOFT_CLIENT_ID?: string;
    OAUTH_MICROSOFT_CLIENT_SECRET?: string;
    OAUTH_MICROSOFT_TENANT: string;
    OAUTH_GITHUB_CLIENT_ID?: string;
    OAUTH_GITHUB_CLIENT_SECRET?: string;
  },
  fetchImpl: typeof fetch = fetch,
): OAuthProviderRegistry {
  const registry = new OAuthProviderRegistry();
  if (config.OAUTH_GOOGLE_CLIENT_ID && config.OAUTH_GOOGLE_CLIENT_SECRET) {
    registry.register(new GoogleOAuthAdapter({ clientId: config.OAUTH_GOOGLE_CLIENT_ID, clientSecret: config.OAUTH_GOOGLE_CLIENT_SECRET }, fetchImpl));
  }
  if (config.OAUTH_MICROSOFT_CLIENT_ID && config.OAUTH_MICROSOFT_CLIENT_SECRET) {
    registry.register(
      new MicrosoftOAuthAdapter({ clientId: config.OAUTH_MICROSOFT_CLIENT_ID, clientSecret: config.OAUTH_MICROSOFT_CLIENT_SECRET }, fetchImpl, config.OAUTH_MICROSOFT_TENANT),
    );
  }
  if (config.OAUTH_GITHUB_CLIENT_ID && config.OAUTH_GITHUB_CLIENT_SECRET) {
    registry.register(new GitHubOAuthAdapter({ clientId: config.OAUTH_GITHUB_CLIENT_ID, clientSecret: config.OAUTH_GITHUB_CLIENT_SECRET }, fetchImpl));
  }
  return registry;
}
