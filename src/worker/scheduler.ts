import { Queue, Worker } from "bullmq";
import type { Logger } from "pino";
import type { Container } from "../app/container.js";
import { createBlockingRedis } from "../core/redis/redis.js";
import { runMaintenance } from "./maintenance.js";

export const MAINTENANCE_QUEUE = "maintenance";

const MINUTE_MS = 60_000;

export interface ScheduledJob {
  name: string;
  everyMs?: number;
  pattern?: string;
  run(container: Container): Promise<unknown>;
}

export const scheduledJobs: ScheduledJob[] = [
  { name: "tokens.cleanup", everyMs: 15 * MINUTE_MS, run: (container) => runMaintenance(container) },
  { name: "retention.purge", pattern: "17 3 * * *", run: (container) => container.retention.run() },
  { name: "privacy.deletions", everyMs: 15 * MINUTE_MS, run: (container) => container.privacy.processDueDeletions() },
  { name: "encryption.rotation-check", everyMs: 360 * MINUTE_MS, run: async (container) => (await container.keyRotation.start(null, null))?.id ?? null },
  { name: "calendar.sync-all", everyMs: 60 * MINUTE_MS, run: (container) => container.calendar.enqueueAll() },
  { name: "files.scan-recovery", everyMs: 30 * MINUTE_MS, run: (container) => container.files.requeueStalledScans() },
];

export function findScheduledJob(name: string): ScheduledJob | undefined {
  return scheduledJobs.find((job) => job.name === name);
}

export async function runScheduledJob(container: Container, name: string): Promise<unknown> {
  const job = findScheduledJob(name);
  if (!job) throw new Error(`Unknown scheduled job ${name}`);
  return job.run(container);
}

export interface SchedulerHandle {
  close(): Promise<void>;
}

export function startScheduler(container: Container, logger: Logger): SchedulerHandle {
  const settings = { url: container.config.REDIS_URL, protocol: container.config.REDIS_PROTOCOL };
  const prefix = `${container.config.REDIS_KEY_PREFIX}bull`;
  const queueConnection = createBlockingRedis(settings, logger);
  const workerConnection = createBlockingRedis(settings, logger);
  const queue = new Queue(MAINTENANCE_QUEUE, {
    connection: queueConnection,
    prefix,
    defaultJobOptions: { removeOnComplete: 200, removeOnFail: 500, attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  });
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      const startedAt = Date.now();
      const result = await runScheduledJob(container, job.name);
      logger.info({ job: job.name, durationMs: Date.now() - startedAt, result }, "scheduled job finished");
      return result;
    },
    { connection: workerConnection, prefix, concurrency: 1 },
  );
  worker.on("failed", (job, error) => logger.error({ err: error, job: job?.name }, "scheduled job failed"));
  worker.on("error", (error) => logger.warn({ err: error }, "scheduler worker error"));
  queue.on("error", (error) => logger.warn({ err: error }, "scheduler queue error"));

  const registration = (async () => {
    for (const job of scheduledJobs) {
      await queue.upsertJobScheduler(job.name, job.pattern ? { pattern: job.pattern, tz: "UTC" } : { every: job.everyMs! }, { name: job.name });
    }
    logger.info({ jobs: scheduledJobs.map((job) => job.name) }, "scheduled jobs registered");
  })().catch((error: unknown) => logger.error({ err: error }, "scheduled job registration failed"));

  return {
    close: async () => {
      await Promise.race([registration, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await Promise.allSettled([worker.close(), queue.close()]);
      await Promise.allSettled([queueConnection.quit(), workerConnection.quit()]);
    },
  };
}
