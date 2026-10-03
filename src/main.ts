import { loadConfig } from "./config/env.js";
import { verifyDatabaseSessionOnStartup } from "./core/database/prisma.js";
import { buildApp } from "./app/build-app.js";
import { createContainer } from "./app/container.js";
import { closeInfrastructure, createInfrastructure } from "./app/infrastructure.js";
import { attachRealtime } from "./modules/realtime/realtime.gateway.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const infra = createInfrastructure(config);
  const container = createContainer(infra);
  await verifyDatabaseSessionOnStartup(infra.db, infra.logger);
  const app = await buildApp(container);
  const realtime = attachRealtime(app.server, container, { revalidateIntervalMs: config.REALTIME_REVALIDATE_INTERVAL_MS });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    container.logger.info({ signal }, "shutting down api");
    const forceExit = setTimeout(() => process.exit(1), 25_000);
    forceExit.unref();
    try {
      await realtime.close();
      await app.close();
      await closeInfrastructure(infra);
      process.exit(0);
    } catch (error) {
      container.logger.error({ err: error }, "shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => container.logger.error({ err: reason }, "unhandled rejection"));

  await app.listen({ host: config.HOST, port: config.PORT });
}

start().catch((error: unknown) => {
  process.stderr.write(`Fatal startup error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
