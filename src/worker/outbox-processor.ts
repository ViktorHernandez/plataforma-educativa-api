import type { Logger } from "pino";
import type { Database } from "../core/database/prisma.js";
import type { Metrics } from "../core/observability/metrics.js";
import type { OutboxEvent } from "../generated/prisma/client.js";

export interface OutboxHandlerContext {
  event: OutboxEvent;
  logger: Logger;
}

export type OutboxHandler = (context: OutboxHandlerContext) => Promise<void>;

export class PermanentEventError extends Error {}

export const MAX_OUTBOX_ATTEMPTS = 8;
const LEASE_SECONDS = 300;

export function backoffSeconds(attempts: number): number {
  return Math.min(3600, 5 * 2 ** Math.max(0, attempts - 1));
}

export class OutboxProcessor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly handlers: Map<string, OutboxHandler>,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly batchSize = 25,
    private readonly concurrency = 5,
  ) {}

  async claimBatch(limit: number): Promise<OutboxEvent[]> {
    return this.db.$queryRaw<OutboxEvent[]>`
      UPDATE "outbox_events"
      SET "dispatchedAt" = now(), "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "outbox_events"
        WHERE "processedAt" IS NULL
          AND "failedAt" IS NULL
          AND "availableAt" <= now()
          AND ("dispatchedAt" IS NULL OR "dispatchedAt" < now() - make_interval(secs => ${LEASE_SECONDS}))
        ORDER BY "availableAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`;
  }

  private async process(event: OutboxEvent): Promise<void> {
    const handler = this.handlers.get(event.type);
    const log = this.logger.child({ outboxEventId: event.id, eventType: event.type, requestId: event.requestId ?? undefined });
    if (!handler) {
      log.error("no handler registered for outbox event");
      await this.db.outboxEvent.update({ where: { id: event.id }, data: { failedAt: new Date(), lastError: "No handler registered" } });
      this.metrics.outboxProcessed.inc({ type: event.type, outcome: "unhandled" });
      return;
    }
    try {
      await handler({ event, logger: log });
      await this.db.outboxEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), lastError: null, sensitivePayload: null } });
      this.metrics.outboxProcessed.inc({ type: event.type, outcome: "success" });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      const permanent = error instanceof PermanentEventError || event.attempts >= MAX_OUTBOX_ATTEMPTS;
      log.warn({ err: error, attempts: event.attempts, permanent }, "outbox event failed");
      await this.db.outboxEvent.update({
        where: { id: event.id },
        data: permanent
          ? { failedAt: new Date(), lastError: message }
          : { dispatchedAt: null, availableAt: new Date(Date.now() + backoffSeconds(event.attempts) * 1000), lastError: message },
      });
      this.metrics.outboxProcessed.inc({ type: event.type, outcome: permanent ? "failed" : "retry" });
    }
  }

  async runOnce(limit = this.batchSize): Promise<number> {
    const events = await this.claimBatch(limit);
    for (let index = 0; index < events.length; index += this.concurrency) {
      await Promise.all(events.slice(index, index + this.concurrency).map((event) => this.process(event)));
    }
    return events.length;
  }

  async drain(maxRounds = 20): Promise<number> {
    let total = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      const processed = await this.runOnce();
      total += processed;
      if (processed === 0) break;
    }
    return total;
  }

  start(intervalMs: number): void {
    const tick = async () => {
      if (this.stopped) return;
      if (!this.running) {
        this.running = true;
        this.idle = (async () => {
          try {
            let processed = await this.runOnce();
            while (processed === this.batchSize && !this.stopped) processed = await this.runOnce();
            const backlog = await this.db.outboxEvent.count({ where: { processedAt: null, failedAt: null } });
            this.metrics.outboxBacklog.set(backlog);
          } catch (error) {
            this.logger.error({ err: error }, "outbox polling failed");
          } finally {
            this.running = false;
          }
        })();
      }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.idle;
  }
}
