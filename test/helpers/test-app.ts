import { createHash, randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/app/build-app.js";
import { createContainer, type Container, type ContainerOptions } from "../../src/app/container.js";
import { closeInfrastructure, createInfrastructure, type InfrastructureOverrides } from "../../src/app/infrastructure.js";
import type { AppInstance } from "../../src/app/types.js";
import { loadConfig } from "../../src/config/env.js";
import { MemoryMailProvider } from "../../src/core/mail/mail-provider.js";
import type { OAuthProviderRegistry } from "../../src/modules/auth/oauth/oauth-providers.js";
import { createOutboxHandlers } from "../../src/worker/handlers/index.js";
import { OutboxProcessor } from "../../src/worker/outbox-processor.js";
import { applyTestEnv } from "./test-env.js";

export interface TestContext {
  app: AppInstance;
  container: Container;
  mail: MemoryMailProvider;
  outbox: OutboxProcessor;
  close(): Promise<void>;
}

export async function createTestContext(
  options: { oauthRegistry?: OAuthProviderRegistry; env?: Record<string, string>; infra?: InfrastructureOverrides; container?: ContainerOptions } = {},
): Promise<TestContext> {
  applyTestEnv();
  for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = value;
  const config = loadConfig();
  const mail = new MemoryMailProvider();
  const infra = createInfrastructure(config, { mail, ...options.infra });
  const container = createContainer(infra, { oauthRegistry: options.oauthRegistry, ...options.container });
  const app = await buildApp(container);
  await app.ready();
  const outbox = new OutboxProcessor(container.db, createOutboxHandlers(container), container.logger, container.metrics, 50, 5);
  return {
    app,
    container,
    mail,
    outbox,
    close: async () => {
      await app.close();
      await closeInfrastructure(infra);
    },
  };
}

export async function resetState(container: Container): Promise<void> {
  const tables = await container.db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((table) => `"public"."${table.tablename}"`).join(", ");
  if (list.length > 0) {
    await container.db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  await container.redis.flushdb();
}

export function json<T = any>(response: LightMyRequestResponse): T {
  return JSON.parse(response.body) as T;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function extractToken(mail: MemoryMailProvider, to: string, path: string): string {
  const message = [...mail.sent].reverse().find((item) => item.to === to && item.text.includes(path));
  if (!message) throw new Error(`No email to ${to} containing ${path}`);
  const match = new RegExp(`${path.replace(/[/]/g, "\\/")}\\?token=([A-Za-z0-9_-]+)`).exec(message.text);
  if (!match) throw new Error("Token not found in email");
  return match[1]!;
}
