import type { AppConfig } from "../../config/env.js";
import { IntegrationProvider } from "../../generated/prisma/enums.js";

export interface CalendarTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export interface CalendarEventInput {
  title: string;
  description: string;
  startsAt: Date;
  endsAt: Date;
  url: string;
}

export class CalendarApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface CalendarProviderClient {
  readonly provider: IntegrationProvider;
  readonly slug: string;
  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<CalendarTokens & { accountEmail: string | null }>;
  refresh(refreshToken: string): Promise<CalendarTokens>;
  upsertEvent(accessToken: string, externalId: string | null, event: CalendarEventInput): Promise<string>;
  deleteEvent(accessToken: string, externalId: string): Promise<void>;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return {} as T;
  }
}

function tokensFrom(body: TokenResponse, fallbackRefresh: string | null): CalendarTokens {
  if (!body.access_token) throw new CalendarApiError(body.error ?? "Token response without access token", 400);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? fallbackRefresh,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    scopes: (body.scope ?? "").split(" ").filter((item) => item.length > 0),
  };
}

abstract class OAuthCalendarProvider implements CalendarProviderClient {
  abstract readonly provider: IntegrationProvider;
  abstract readonly slug: string;
  protected abstract readonly authorizeEndpoint: string;
  protected abstract readonly tokenEndpoint: string;
  protected abstract readonly scopes: string[];

  constructor(
    protected readonly clientId: string,
    protected readonly clientSecret: string,
    protected readonly fetchImpl: typeof fetch = fetch,
  ) {}

  protected extraAuthorizeParams(): Record<string, string> {
    return {};
  }

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(this.authorizeEndpoint);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: this.scopes.join(" "),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      ...this.extraAuthorizeParams(),
    }).toString();
    return url.toString();
  }

  protected async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await readJson<TokenResponse>(response);
    if (!response.ok) throw new CalendarApiError(`Token endpoint returned ${response.status}${body.error ? ` ${body.error}` : ""}`, response.status);
    return body;
  }

  protected abstract accountEmail(accessToken: string): Promise<string | null>;

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }) {
    const body = await this.tokenRequest({ grant_type: "authorization_code", code: input.code, code_verifier: input.codeVerifier, redirect_uri: input.redirectUri });
    const tokens = tokensFrom(body, null);
    return { ...tokens, accountEmail: await this.accountEmail(tokens.accessToken).catch(() => null) };
  }

  async refresh(refreshToken: string): Promise<CalendarTokens> {
    return tokensFrom(await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }), refreshToken);
  }

  protected async api(accessToken: string, method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 204 || (method === "DELETE" && (response.status === 404 || response.status === 410))) return {};
    const payload = await readJson<Record<string, unknown>>(response);
    if (!response.ok) throw new CalendarApiError(`${this.slug} calendar API returned ${response.status}`, response.status);
    return payload;
  }

  abstract upsertEvent(accessToken: string, externalId: string | null, event: CalendarEventInput): Promise<string>;
  abstract deleteEvent(accessToken: string, externalId: string): Promise<void>;
}

export class GoogleCalendarProvider extends OAuthCalendarProvider {
  readonly provider = IntegrationProvider.GOOGLE_CALENDAR;
  readonly slug = "google";
  protected readonly authorizeEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
  protected readonly tokenEndpoint = "https://oauth2.googleapis.com/token";
  protected readonly scopes = ["openid", "email", "https://www.googleapis.com/auth/calendar.events"];
  private readonly eventsUrl = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

  protected override extraAuthorizeParams(): Record<string, string> {
    return { access_type: "offline", prompt: "consent", include_granted_scopes: "true" };
  }

  protected async accountEmail(accessToken: string): Promise<string | null> {
    const body = await this.api(accessToken, "GET", "https://openidconnect.googleapis.com/v1/userinfo");
    return typeof body["email"] === "string" ? body["email"] : null;
  }

  async upsertEvent(accessToken: string, externalId: string | null, event: CalendarEventInput): Promise<string> {
    const payload = {
      summary: event.title,
      description: `${event.description}\n${event.url}`,
      start: { dateTime: event.startsAt.toISOString() },
      end: { dateTime: event.endsAt.toISOString() },
      source: { title: event.title, url: event.url },
    };
    const body = externalId
      ? await this.api(accessToken, "PATCH", `${this.eventsUrl}/${encodeURIComponent(externalId)}`, payload)
      : await this.api(accessToken, "POST", this.eventsUrl, payload);
    const id = body["id"];
    if (typeof id !== "string") throw new CalendarApiError("Calendar event without id", 502);
    return id;
  }

  async deleteEvent(accessToken: string, externalId: string): Promise<void> {
    await this.api(accessToken, "DELETE", `${this.eventsUrl}/${encodeURIComponent(externalId)}`);
  }
}

export class MicrosoftCalendarProvider extends OAuthCalendarProvider {
  readonly provider = IntegrationProvider.MICROSOFT_CALENDAR;
  readonly slug = "microsoft";
  protected readonly authorizeEndpoint: string;
  protected readonly tokenEndpoint: string;
  protected readonly scopes = ["openid", "email", "offline_access", "User.Read", "Calendars.ReadWrite"];
  private readonly eventsUrl = "https://graph.microsoft.com/v1.0/me/events";

  constructor(clientId: string, clientSecret: string, tenant: string, fetchImpl: typeof fetch = fetch) {
    super(clientId, clientSecret, fetchImpl);
    const base = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
    this.authorizeEndpoint = `${base}/authorize`;
    this.tokenEndpoint = `${base}/token`;
  }

  protected async accountEmail(accessToken: string): Promise<string | null> {
    const body = await this.api(accessToken, "GET", "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName");
    const mail = body["mail"] ?? body["userPrincipalName"];
    return typeof mail === "string" ? mail : null;
  }

  async upsertEvent(accessToken: string, externalId: string | null, event: CalendarEventInput): Promise<string> {
    const payload = {
      subject: event.title,
      body: { contentType: "text", content: `${event.description}\n${event.url}` },
      start: { dateTime: event.startsAt.toISOString().replace("Z", ""), timeZone: "UTC" },
      end: { dateTime: event.endsAt.toISOString().replace("Z", ""), timeZone: "UTC" },
    };
    const body = externalId
      ? await this.api(accessToken, "PATCH", `${this.eventsUrl}/${encodeURIComponent(externalId)}`, payload)
      : await this.api(accessToken, "POST", this.eventsUrl, payload);
    const id = body["id"];
    if (typeof id !== "string") throw new CalendarApiError("Calendar event without id", 502);
    return id;
  }

  async deleteEvent(accessToken: string, externalId: string): Promise<void> {
    await this.api(accessToken, "DELETE", `${this.eventsUrl}/${encodeURIComponent(externalId)}`);
  }
}

export type CalendarProviderRegistry = Map<string, CalendarProviderClient>;

export function buildCalendarRegistry(config: AppConfig): CalendarProviderRegistry {
  const registry: CalendarProviderRegistry = new Map();
  if (!config.CALENDAR_SYNC_ENABLED) return registry;
  if (config.OAUTH_GOOGLE_CLIENT_ID && config.OAUTH_GOOGLE_CLIENT_SECRET) {
    const google = new GoogleCalendarProvider(config.OAUTH_GOOGLE_CLIENT_ID, config.OAUTH_GOOGLE_CLIENT_SECRET);
    registry.set(google.slug, google);
  }
  if (config.OAUTH_MICROSOFT_CLIENT_ID && config.OAUTH_MICROSOFT_CLIENT_SECRET) {
    const microsoft = new MicrosoftCalendarProvider(config.OAUTH_MICROSOFT_CLIENT_ID, config.OAUTH_MICROSOFT_CLIENT_SECRET, config.OAUTH_MICROSOFT_TENANT);
    registry.set(microsoft.slug, microsoft);
  }
  return registry;
}
