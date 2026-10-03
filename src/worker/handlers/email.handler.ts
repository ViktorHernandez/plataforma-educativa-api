import type { Database } from "../../core/database/prisma.js";
import type { OutboxService } from "../../core/events/outbox.js";
import { formatDateTime, resolveLocale } from "../../core/i18n/translator.js";
import { EMAIL_SEND_EVENT, type EmailSendPayload, type EmailSendSensitive } from "../../core/mail/email-queue.js";
import { MailDeliveryError, type MailProvider } from "../../core/mail/mail-provider.js";
import { renderEmail } from "../../core/mail/templates.js";
import { PermanentEventError, type OutboxHandler } from "../outbox-processor.js";

export function createEmailHandler(db: Database, outbox: OutboxService, mail: MailProvider): OutboxHandler {
  return async ({ event, logger }) => {
    const payload = event.payload as unknown as EmailSendPayload;
    const sensitive = outbox.readSensitive(EMAIL_SEND_EVENT, event.sensitivePayload) as unknown as EmailSendSensitive;
    if (!sensitive.to) throw new PermanentEventError("Missing recipient");
    const suppressed = await db.emailSuppression.findUnique({ where: { email: sensitive.to } });
    if (suppressed) {
      logger.info({ reason: suppressed.reason }, "email suppressed");
      return;
    }
    const locale = resolveLocale(payload.locale);
    const values = { ...payload.values };
    for (const [key, iso] of Object.entries(payload.dateValues ?? {})) {
      values[key] = formatDateTime(new Date(iso), locale, payload.timezone);
    }
    const rendered = renderEmail({ template: payload.template, locale, values, actionUrl: sensitive.actionUrl });
    try {
      await mail.send({
        to: sensitive.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tags: { template: payload.template },
        idempotencyKey: event.id,
      });
    } catch (error) {
      if (error instanceof MailDeliveryError && !error.retryable) throw new PermanentEventError(error.message);
      throw error;
    }
  };
}
