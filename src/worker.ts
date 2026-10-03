import { createServer } from "node:http";
import { loadConfig } from "./config/env.js";
import { verifyDatabaseSessionOnStartup } from "./core/database/prisma.js";
import { constantTimeEqual } from "./core/crypto/random.js";
import { createContainer } from "./app/container.js";
import { closeInfrastructure, createInfrastructure } from "./app/infrastructure.js";
import { createOutboxHandlers } from "./worker/handlers/index.js";
import { syncSystemRoles } from "./modules/access/system-bootstrap.js";
import { OutboxProcessor } from "./worker/outbox-processor.js";
import { startScheduler, type SchedulerHandle } from "./worker/scheduler.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const infra = createInfrastructure(config);
  const container = createContainer(infra);
  await verifyDatabaseSessionOnStartup(infra.db, infra.logger);
  const logger = container.logger.child({ role: "worker" });
  const processor = new OutboxProcessor(container.db, createOutboxHandlers(container), logger, container.metrics, 25, config.WORKER_CONCURRENCY);
  process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled rejection"));
  await syncSystemRoles(container.db).catch((error: unknown) => logger.error({ err: error }, "system role synchronization failed"));
  processor.start(config.OUTBOX_POLL_INTERVAL_MS);
  const scheduler: SchedulerHandle | null = config.SCHEDULER_ENABLED ? startScheduler(container, logger) : null;

  const healthServer = createServer((request, response) => {
    if (request.url === "/health/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", role: "worker" }));
      return;
    }
    if (request.url === "/metrics" && config.METRICS_TOKEN && constantTimeEqual(request.headers.authorization ?? "", `Bearer ${config.METRICS_TOKEN}`)) {
      void container.metrics.registry.metrics().then((body) => {
        response.writeHead(200, { "content-type": container.metrics.registry.contentType });
        response.end(body);
      });
      return;
    }
    response.writeHead(404).end();
  });
  healthServer.listen(config.WORKER_PORT, config.WORKER_HOST);
  logger.info({ port: config.WORKER_PORT }, "worker started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down worker");
    const forceExit = setTimeout(() => process.exit(1), 25_000);
    forceExit.unref();
    await processor.stop();
    await scheduler?.close();
    healthServer.close();
    await closeInfrastructure(infra);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

start().catch((error: unknown) => {
  process.stderr.write(`Fatal worker error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
