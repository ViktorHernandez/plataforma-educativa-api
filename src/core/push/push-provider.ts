import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";
import type { Logger } from "pino";

export type PushChannel = "FCM" | "WEB_PUSH";

export interface PushTarget {
  provider: PushChannel;
  token: string;
  p256dh?: string | null;
  authSecret?: string | null;
}

export interface PushMessage {
  target: PushTarget;
  title: string;
  body: string;
  data?: Record<string, string>;
  urgent?: boolean;
}

export interface PushResult {
  delivered: boolean;
  invalidToken: boolean;
  retryable?: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface PushProvider {
  readonly name: string;
  readonly enabled: boolean;
  send(message: PushMessage): Promise<PushResult>;
}

export class DisabledPushProvider implements PushProvider {
  readonly name = "none";
  readonly enabled = false;

  send(): Promise<PushResult> {
    return Promise.resolve({ delivered: false, invalidToken: false, retryable: false, error: "push disabled" });
  }
}

export class PushDispatcher {
  constructor(private readonly providers: Partial<Record<PushChannel, PushProvider>>) {}

  isEnabled(channel: PushChannel): boolean {
    return this.providers[channel]?.enabled === true;
  }

  get enabledChannels(): PushChannel[] {
    return (Object.keys(this.providers) as PushChannel[]).filter((channel) => this.isEnabled(channel));
  }

  get anyEnabled(): boolean {
    return this.enabledChannels.length > 0;
  }

  providerName(channel: PushChannel): string {
    return this.providers[channel]?.name ?? "none";
  }

  async send(message: PushMessage): Promise<PushResult> {
    const provider = this.providers[message.target.provider];
    if (!provider?.enabled) return { delivered: false, invalidToken: false, retryable: false, error: "provider disabled" };
    return provider.send(message);
  }
}

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKeyPem: string;
}

export class FcmPushProvider implements PushProvider {
  readonly name = "fcm";
  readonly enabled = true;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly credentials: FcmCredentials,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) return this.cachedToken.value;
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.credentials.clientEmail)
      .setSubject(this.credentials.clientEmail)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(createPrivateKey(this.credentials.privateKeyPem));
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`FCM token exchange failed with status ${response.status}`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async send(message: PushMessage): Promise<PushResult> {
    try {
      const token = await this.accessToken();
      const response = await this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.credentials.projectId)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token: message.target.token,
            notification: { title: message.title, body: message.body },
            data: message.data ?? {},
            android: { priority: message.urgent ? "HIGH" : "NORMAL" },
            apns: { payload: { aps: { sound: "default" } } },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const body = (await response.json()) as { name?: string };
        return { delivered: true, invalidToken: false, providerMessageId: body.name };
      }
      const errorBody = (await response.json().catch(() => ({}))) as { error?: { status?: string } };
      const status = errorBody.error?.status ?? "";
      const invalidToken = response.status === 404 || status === "UNREGISTERED" || status === "INVALID_ARGUMENT";
      const retryable = response.status === 429 || response.status >= 500 || status === "UNAVAILABLE" || status === "INTERNAL";
      return { delivered: false, invalidToken, retryable, error: `FCM status ${response.status} ${status}`.trim() };
    } catch (error) {
      this.logger.warn({ err: error }, "fcm push failed");
      return { delivered: false, invalidToken: false, retryable: true, error: error instanceof Error ? error.message : "unknown" };
    }
  }
}
