import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type { Logger } from "pino";
import type { AppConfig } from "../../config/env.js";
import { isUtcTimeZone, REQUIRED_SESSION_TIMEZONE, resolveDatabaseConnection } from "./connection.js";

export type Database = PrismaClient;
export type Tx = Prisma.TransactionClient;
export type DbClient = Database | Tx;

export type DatabaseSettings = Pick<AppConfig, "DATABASE_URL" | "DATABASE_POOL_MAX" | "DATABASE_STATEMENT_TIMEOUT_MS"> &
  Partial<Pick<AppConfig, "DATABASE_LOG_QUERIES" | "DATABASE_SSL_MODE" | "DATABASE_SSL_CA_BASE64" | "DATABASE_POOLER">>;

export function createDatabase(config: DatabaseSettings, logger?: Logger): Database {
  const connection = resolveDatabaseConnection({
    url: config.DATABASE_URL,
    poolMax: config.DATABASE_POOL_MAX,
    statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    sslMode: config.DATABASE_SSL_MODE,
    sslCaBase64: config.DATABASE_SSL_CA_BASE64,
    pooler: config.DATABASE_POOLER,
  });
  logger?.debug({ host: connection.host, sslMode: connection.effectiveSslMode, pooler: connection.usesPooler }, "database connection configured");
  const adapter = new PrismaPg(connection.poolConfig);
  if (config.DATABASE_LOG_QUERIES && logger) {
    const client = new PrismaClient({ adapter, log: [{ emit: "event" as const, level: "query" as const }] });
    client.$on("query", (event: Prisma.QueryEvent) => logger.debug({ durationMs: event.duration, query: event.query }, "database query"));
    return client;
  }
  return new PrismaClient({ adapter });
}

export class DatabaseTimeZoneError extends Error {}

export async function verifyDatabaseSessionOnStartup(db: Database, logger: Logger): Promise<void> {
  try {
    await assertDatabaseSessionTimeZone(db);
  } catch (error) {
    if (error instanceof DatabaseTimeZoneError) throw error;
    logger.warn({ err: error }, "database session check skipped because the database is not reachable yet");
  }
}

export async function assertDatabaseSessionTimeZone(db: Database): Promise<void> {
  const rows = await db.$queryRaw<Array<{ timezone: string }>>`SELECT current_setting('TimeZone') AS timezone`;
  const timezone = rows[0]?.timezone ?? "";
  if (!isUtcTimeZone(timezone)) {
    throw new DatabaseTimeZoneError(
      `The database session time zone is "${timezone}" but must be ${REQUIRED_SESSION_TIMEZONE}. Run ALTER ROLE <app_role> SET timezone TO 'UTC' (or ALTER DATABASE) when connecting through a pooler.`,
    );
  }
}

export function isUniqueViolation(error: unknown, target?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  if (!target) return true;
  const meta = JSON.stringify(error.meta ?? {});
  return meta.includes(target);
}

export function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

export function isCheckViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2004") return true;
  const message = error instanceof Error ? error.message : "";
  return message.includes("violates check constraint");
}

export { Prisma };
