import type { Logger } from "pino";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  tags?: Record<string, string>;
  idempotencyKey?: string;
}

export interface MailSendResult {
  providerMessageId: string | null;
}

export interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<MailSendResult>;
}

export class MailDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class ConsoleMailProvider implements MailProvider {
  readonly name = "console";

  constructor(private readonly logger: Logger) {}

  async send(message: MailMessage): Promise<MailSendResult> {
    this.logger.info({ mail: { to: message.to, subject: message.subject, text: message.text } }, "development email");
    return { providerMessageId: null };
  }
}

export class MemoryMailProvider implements MailProvider {
  readonly name = "memory";
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<MailSendResult> {
    this.sent.push(message);
    return { providerMessageId: `memory-${this.sent.length}` };
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export class ResendMailProvider implements MailProvider {
  readonly name = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: MailMessage): Promise<MailSendResult> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
    if (message.idempotencyKey) headers["idempotency-key"] = message.idempotencyKey;
    let response: Response;
    try {
      response = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          tags: Object.entries(message.tags ?? {}).map(([name, value]) => ({ name, value })),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new MailDeliveryError(`Resend request failed: ${error instanceof Error ? error.message : "unknown"}`, true);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new MailDeliveryError(`Resend rejected the message with status ${response.status}`, retryable);
    }
    const body = (await response.json().catch(() => ({}))) as { id?: string };
    return { providerMessageId: body.id ?? null };
  }
}
