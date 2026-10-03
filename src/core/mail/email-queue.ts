import type { DbClient } from "../database/prisma.js";
import type { OutboxService } from "../events/outbox.js";
import type { TranslationParams } from "../i18n/translator.js";
import type { EmailTemplate } from "./templates.js";

export const EMAIL_SEND_EVENT = "email.send";

export interface QueuedEmail {
  template: EmailTemplate;
  to: string;
  userId?: string;
  locale: string;
  timezone?: string;
  values: TranslationParams;
  dateValues?: Record<string, string>;
  actionUrl?: string;
  requestId?: string | null;
}

export interface EmailSendPayload {
  template: EmailTemplate;
  userId: string | null;
  locale: string;
  timezone: string;
  values: TranslationParams;
  dateValues: Record<string, string>;
}

export interface EmailSendSensitive {
  to: string;
  actionUrl?: string;
}

export class EmailQueue {
  constructor(private readonly outbox: OutboxService) {}

  async enqueue(client: DbClient, email: QueuedEmail): Promise<void> {
    const payload: EmailSendPayload = {
      template: email.template,
      userId: email.userId ?? null,
      locale: email.locale,
      timezone: email.timezone ?? "UTC",
      values: email.values,
      dateValues: email.dateValues ?? {},
    };
    const sensitive: EmailSendSensitive = { to: email.to, actionUrl: email.actionUrl };
    await this.outbox.enqueue(client, {
      type: EMAIL_SEND_EVENT,
      aggregateType: "user",
      aggregateId: email.userId,
      payload: payload as unknown as Record<string, unknown>,
      sensitive: sensitive as unknown as Record<string, unknown>,
      requestId: email.requestId ?? null,
    });
  }
}
