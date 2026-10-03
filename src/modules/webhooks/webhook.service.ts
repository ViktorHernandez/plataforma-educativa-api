import { createHmac } from "node:crypto";
import type { Logger } from "pino";
import { constantTimeEqual } from "../../core/crypto/random.js";
import type { Database } from "../../core/database/prisma.js";
import { isUniqueViolation } from "../../core/database/prisma.js";
import type { OutboxService } from "../../core/events/outbox.js";
import { AppError, ErrorCode } from "../../core/http/errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { WebhookEventStatus } from "../../generated/prisma/enums.js";

export const WEBHOOK_PROCESS_EVENT = "webhook.process";
const TOLERANCE_SECONDS = 300;

export interface SignedHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export function verifySvixSignature(secret: string, headers: SignedHeaders, rawBody: string, now = Date.now()): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest("base64");
  return headers.signature
    .split(" ")
    .map((part) => part.split(",")[1] ?? "")
    .some((candidate) => candidate.length > 0 && constantTimeEqual(candidate, expected));
}

export class WebhookService {
  constructor(
    private readonly db: Database,
    private readonly outbox: OutboxService,
    private readonly logger: Logger,
  ) {}

  async receiveResend(secret: string | undefined, headers: SignedHeaders, rawBody: string): Promise<{ duplicate: boolean }> {
    if (!secret) throw new AppError(404, ErrorCode.NOT_FOUND, "Webhook not configured");
    if (!verifySvixSignature(secret, headers, rawBody)) throw new AppError(401, ErrorCode.WEBHOOK_SIGNATURE_INVALID, "Invalid signature");
    let payload: { type?: string; data?: Record<string, unknown> };
    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      throw new AppError(400, ErrorCode.BAD_REQUEST, "Invalid JSON");
    }
    try {
      await this.db.$transaction(async (tx) => {
        const event = await tx.inboundWebhookEvent.create({
          data: { provider: "resend", externalId: headers.id!, eventType: String(payload.type ?? "unknown").slice(0, 100), payload: payload as Prisma.InputJsonValue },
        });
        await this.outbox.enqueue(tx, { type: WEBHOOK_PROCESS_EVENT, aggregateType: "webhook", aggregateId: event.id, payload: { webhookEventId: event.id } });
      });
      return { duplicate: false };
    } catch (error) {
      if (isUniqueViolation(error)) return { duplicate: true };
      throw error;
    }
  }

  async process(webhookEventId: string): Promise<void> {
    const event = await this.db.inboundWebhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!event || event.status === WebhookEventStatus.PROCESSED) return;
    const payload = event.payload as { type?: string; data?: { to?: string[] | string } };
    const recipients = Array.isArray(payload.data?.to) ? payload.data.to : payload.data?.to ? [payload.data.to] : [];
    const suppressionReason = event.eventType === "email.bounced" ? "bounced" : event.eventType === "email.complained" ? "complained" : null;
    if (suppressionReason) {
      for (const address of recipients) {
        const email = String(address).toLowerCase().slice(0, 320);
        await this.db.emailSuppression.upsert({ where: { email }, create: { email, reason: suppressionReason }, update: { reason: suppressionReason } });
      }
      this.logger.info({ eventType: event.eventType, recipients: recipients.length }, "email suppression updated");
    }
    await this.db.inboundWebhookEvent.update({
      where: { id: event.id },
      data: { status: suppressionReason ? WebhookEventStatus.PROCESSED : WebhookEventStatus.IGNORED, processedAt: new Date(), attempts: { increment: 1 } },
    });
  }
}
