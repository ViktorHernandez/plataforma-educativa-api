import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import pg from "pg";
import { loadConfig, type AppConfig } from "../src/config/env.js";
import { ClamAvScanner } from "../src/core/antivirus/clamav-scanner.js";
import { databaseTargetId, isLocalDatabaseHost, isUtcTimeZone, resolveDatabaseConnection, supabaseProjectRef } from "../src/core/database/connection.js";
import { redisOptions } from "../src/core/redis/redis.js";

type Level = "PASS" | "WARN" | "FAIL" | "INFO";

const results: Array<{ level: Level; check: string; detail: string }> = [];
const migrationsDirectory = path.resolve("prisma", "migrations");
const demoRegistryKey = "demo.dataset.registry";
const demoEmailDomain = "demo.plataforma.test";

function report(level: Level, check: string, detail = "") {
  results.push({ level, check, detail });
  console.log(`${level.padEnd(4)} ${check}${detail ? ` - ${detail}` : ""}`);
}

function describeConnectionError(error: unknown): string {
  const code = (error as { code?: string }).code ?? "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOTFOUND") return "the host name does not resolve; check the project reference in the URL";
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "EADDRNOTAVAIL") return "the network cannot reach this address; the Supabase direct host needs IPv6 or the IPv4 add-on";
  if (code === "ETIMEDOUT" || /timeout/i.test(message)) return "the connection timed out; check the firewall, VPN, IPv6 support and Supabase network restrictions";
  if (code === "ECONNREFUSED") return "the connection was refused; check the host and port";
  if (code === "28P01") return "password authentication failed; check the database password in the URL (URL encode special characters)";
  if (code === "3D000") return "the database does not exist";
  if (/tenant or user not found/i.test(message)) return "the pooler did not recognise the user; pooler URLs use the user postgres.<project-ref>";
  if (/self[- ]signed|certificate/i.test(message)) return `TLS certificate validation failed (${message}); with verify-full provide DATABASE_SSL_CA_BASE64`;
  return `${code ? `${code} ` : ""}${message}`;
}

async function localMigrations(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(migrationsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(migrationsDirectory, entry.name, "migration.sql");
    if (!existsSync(file)) continue;
    result.set(entry.name, createHash("sha256").update(await readFile(file)).digest("hex"));
  }
  return result;
}

async function projectTables(): Promise<Set<string>> {
  const tables = new Set<string>(["_prisma_migrations"]);
  for (const name of (await localMigrations()).keys()) {
    const sql = await readFile(path.join(migrationsDirectory, name, "migration.sql"), "utf8");
    for (const match of sql.matchAll(/CREATE TABLE "([^"]+)"/g)) tables.add(match[1]!);
  }
  return tables;
}

async function checkDatabase(name: string, url: string, config: AppConfig): Promise<pg.Client | null> {
  const resolved = resolveDatabaseConnection({
    url,
    poolMax: 1,
    statementTimeoutMs: 0,
    sslMode: config.DATABASE_SSL_MODE,
    sslCaBase64: config.DATABASE_SSL_CA_BASE64,
    pooler: config.DATABASE_POOLER,
  });
  const port = new URL(url).port || "5432";
  const mode = resolved.usesPooler ? (port === "6543" ? "transaction pooler" : "pooler (session mode)") : "direct connection";
  report("INFO", `${name} target`, `${databaseTargetId(url)} via ${resolved.host}:${port} (${mode}, TLS ${resolved.effectiveSslMode})`);
  let ipv6Only: boolean;
  try {
    const addresses = await lookup(resolved.host, { all: true });
    const families = new Set(addresses.map((address) => address.family));
    ipv6Only = !families.has(4);
    if (!ipv6Only) report("PASS", `${name} DNS`, `IPv4${families.has(6) ? " and IPv6" : ""}`);
    else report("WARN", `${name} DNS`, "only IPv6 addresses; this network needs IPv6 or the Supabase IPv4 add-on, otherwise use the session pooler for this URL");
  } catch (error) {
    report("FAIL", `${name} DNS`, describeConnectionError(error));
    return null;
  }
  const client = new pg.Client({ ...resolved.poolConfig, connectionTimeoutMillis: 15_000 });
  const started = performance.now();
  try {
    await client.connect();
  } catch (error) {
    const detail = ipv6Only ? `this computer could not open an IPv6 connection (${describeConnectionError(error)}); enable IPv6, buy the Supabase IPv4 add-on or use the session pooler URL` : describeConnectionError(error);
    report("FAIL", `${name} connection`, detail);
    await client.end().catch(() => undefined);
    return null;
  }
  const encrypted = (client as unknown as { connection?: { stream?: Partial<TLSSocket> } }).connection?.stream?.encrypted === true;
  report(encrypted || isLocalDatabaseHost(resolved.host) ? "PASS" : "FAIL", `${name} connection`, `connected in ${Math.round(performance.now() - started)} ms, TLS ${encrypted ? "active" : "not used"}`);
  const info = await client.query<{ version: string; user: string; database: string; timezone: string }>(
    "SELECT current_setting('server_version') AS version, current_user AS user, current_database() AS database, current_setting('TimeZone') AS timezone",
  );
  const row = info.rows[0]!;
  report("INFO", `${name} server`, `PostgreSQL ${row.version}, user ${row.user}, database ${row.database}`);
  report(isUtcTimeZone(row.timezone) ? "PASS" : "FAIL", `${name} session time zone`, row.timezone);
  const samples: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const begin = performance.now();
    await client.query("SELECT 1");
    samples.push(performance.now() - begin);
  }
  const median = samples.sort((a, b) => a - b)[2]!;
  report(median > 250 ? "WARN" : "PASS", `${name} round trip`, `${Math.round(median)} ms median${median > 250 ? "; transactions with many statements may approach the 5 s interactive transaction limit" : ""}`);
  return client;
}

async function inspectSchema(client: pg.Client, url: string) {
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    const expected = await projectTables();
    const local = await localMigrations();
    const tables = (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((item) => item.tablename);
    const foreign = tables.filter((table) => !expected.has(table));
    const hasHistory = tables.includes("_prisma_migrations");
    if (!hasHistory) {
      if (tables.length === 0) report("PASS", "Schema public", "empty, ready for the first npm run db:migrate");
      else report("FAIL", "Schema public", `contains ${tables.length} tables without Prisma migration history (${tables.slice(0, 10).join(", ")}); confirm the database belongs to this project before migrating`);
    } else if (foreign.length > 0) {
      report("WARN", "Schema public", `tables not created by this project's migrations: ${foreign.join(", ")}`);
    } else {
      report("PASS", "Schema public", `${tables.length} tables, all created by this project's migrations`);
    }
    if (hasHistory) {
      const applied = (
        await client.query<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>(
          'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at',
        )
      ).rows;
      const active = applied.filter((item) => item.rolled_back_at === null);
      const failed = active.filter((item) => item.finished_at === null).map((item) => item.migration_name);
      const unknown = active.filter((item) => !local.has(item.migration_name)).map((item) => item.migration_name);
      const modified = active.filter((item) => local.has(item.migration_name) && local.get(item.migration_name) !== item.checksum).map((item) => item.migration_name);
      const pending = [...local.keys()].filter((name) => !active.some((item) => item.migration_name === name && item.finished_at !== null));
      if (failed.length > 0) report("FAIL", "Migrations", `failed migrations recorded: ${failed.join(", ")}`);
      if (unknown.length > 0) report("FAIL", "Migrations", `applied migrations that do not exist in prisma/migrations: ${unknown.join(", ")}`);
      if (modified.length > 0) report("FAIL", "Migrations", `migration files changed after being applied: ${modified.join(", ")}`);
      if (pending.length > 0) report("WARN", "Migrations", `pending: ${pending.join(", ")}; run npm run db:migrate`);
      if (failed.length + unknown.length + modified.length + pending.length === 0) report("PASS", "Migrations", `${active.length} applied, identical to prisma/migrations`);
    } else {
      report("INFO", "Migrations", `${local.size} local migrations, none applied yet`);
    }
    if (supabaseProjectRef(url)) {
      const roles = (await client.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')")).rows.map((item) => item.rolname);
      const exposed: string[] = [];
      for (const table of tables) {
        const flags = await client.query<{ rls: boolean; granted: boolean }>(
          `SELECT c.relrowsecurity AS rls, ${roles.length > 0 ? roles.map((role) => `has_table_privilege('${role}', c.oid, 'SELECT,INSERT,UPDATE,DELETE')`).join(" OR ") : "false"} AS granted
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1`,
          [table],
        );
        const flag = flags.rows[0];
        if (flag && (!flag.rls || flag.granted)) exposed.push(table);
      }
      if (exposed.length > 0) report("WARN", "Supabase Data API exposure", `tables readable by anon/authenticated or without RLS: ${exposed.join(", ")}`);
      else if (tables.length > 0) report("PASS", "Supabase Data API exposure", "no public table is granted to anon or authenticated and RLS is enabled");
    }
    if (tables.includes("users")) {
      const counts = (
        await client.query<{ users: string; demo: string; institutions: string }>(
          `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM users WHERE email LIKE $1) AS demo, (SELECT count(*) FROM institutions WHERE "isPlatform" = false) AS institutions`,
          [`%@${demoEmailDomain}`],
        )
      ).rows[0]!;
      const registry = tables.includes("platform_settings") ? (await client.query("SELECT 1 FROM platform_settings WHERE key = $1", [demoRegistryKey])).rowCount : 0;
      report("INFO", "Data", `${counts.users} users (${counts.demo} demo), ${counts.institutions} institutions, demo registry ${registry ? "present" : "absent"}`);
    }
  } finally {
    await client.query("ROLLBACK");
  }
}

async function checkRedis(config: AppConfig) {
  const redis = new Redis(config.REDIS_URL, redisOptions({ url: config.REDIS_URL, protocol: config.REDIS_PROTOCOL, commandTimeoutMs: 5000 }, { lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0 }));
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await redis.ping();
    const version = /redis_version:([^\r\n]+)/.exec(await redis.info("server"))?.[1] ?? "unknown";
    report("PASS", "Redis", `${new URL(config.REDIS_URL).hostname} responds, version ${version}${config.REDIS_URL.startsWith("rediss://") ? ", TLS" : ""}`);
    try {
      const policy = await redis.config("GET", "maxmemory-policy");
      report(policy[1] === "noeviction" ? "PASS" : "WARN", "Redis maxmemory-policy", `${policy[1] ?? "unknown"}${policy[1] === "noeviction" ? "" : "; BullMQ requires noeviction"}`);
    } catch {
      report("INFO", "Redis maxmemory-policy", "the provider does not expose CONFIG GET; confirm noeviction in its dashboard");
    }
  } catch (error) {
    report("FAIL", "Redis", `${config.REDIS_URL.replace(/\/\/[^@]*@/, "//***@")} is not reachable (${error instanceof Error ? error.message : String(error)}); start it with npm run services:up`);
  } finally {
    redis.disconnect();
  }
}

async function checkIntegrations(config: AppConfig) {
  if (config.ANTIVIRUS_PROVIDER === "clamav") {
    const scanner = new ClamAvScanner({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT, timeoutMs: 5000 });
    report((await scanner.ping()) ? "PASS" : config.FILE_SCAN_REQUIRED ? "FAIL" : "WARN", "ClamAV", `${config.CLAMAV_HOST}:${config.CLAMAV_PORT}`);
  } else {
    report("INFO", "ClamAV", "disabled (ANTIVIRUS_PROVIDER=disabled)");
  }
  if (config.STORAGE_PROVIDER === "s3" && config.S3_BUCKET && config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY) {
    const client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
    });
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
      report("PASS", "Object storage", `bucket ${config.S3_BUCKET} is reachable with the configured credentials`);
    } catch (error) {
      report("FAIL", "Object storage", `bucket ${config.S3_BUCKET}: ${error instanceof Error ? error.name : String(error)}`);
    }
  } else {
    report("INFO", "Object storage", `${config.STORAGE_PROVIDER} (${config.STORAGE_PROVIDER === "local" ? path.resolve(config.STORAGE_LOCAL_DIR) : "incomplete S3 settings"})`);
  }
  const configured = (value: unknown) => (value ? "configured" : "not configured");
  report("INFO", "Email", config.MAIL_PROVIDER === "resend" ? `Resend ${configured(config.RESEND_API_KEY)}` : `${config.MAIL_PROVIDER} provider, no real delivery`);
  report("INFO", "Push", `FCM ${config.PUSH_FCM_ENABLED ? "enabled" : "disabled"}, Web Push ${config.PUSH_WEB_ENABLED ? "enabled" : "disabled"}`);
  const providers = [
    ["Google", config.OAUTH_GOOGLE_CLIENT_ID && config.OAUTH_GOOGLE_CLIENT_SECRET],
    ["Microsoft", config.OAUTH_MICROSOFT_CLIENT_ID && config.OAUTH_MICROSOFT_CLIENT_SECRET],
    ["GitHub", config.OAUTH_GITHUB_CLIENT_ID && config.OAUTH_GITHUB_CLIENT_SECRET],
  ].filter(([, enabled]) => enabled).map(([name]) => name);
  report("INFO", "OAuth", providers.length > 0 ? `enabled: ${providers.join(", ")}; redirect allowlist ${config.OAUTH_REDIRECT_ALLOWLIST.length} entries` : "no provider configured");
  report("INFO", "Calendar sync", config.CALENDAR_SYNC_ENABLED ? `enabled, ${config.CALENDAR_SYNC_WINDOW_DAYS} days window` : "disabled");
}

async function main() {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    report("FAIL", "Configuration", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  report("PASS", "Configuration", `APP_ENV=${config.APP_ENV}, NODE_ENV=${config.NODE_ENV}`);
  const pooled = await checkDatabase("DATABASE_URL", config.DATABASE_URL, config);
  const direct = config.DIRECT_DATABASE_URL ? await checkDatabase("DIRECT_DATABASE_URL", config.DIRECT_DATABASE_URL, config) : null;
  if (!config.DIRECT_DATABASE_URL) report("INFO", "DIRECT_DATABASE_URL", "not set, Prisma CLI will use DATABASE_URL");
  const inspector = direct ?? pooled;
  if (inspector) await inspectSchema(inspector, config.DIRECT_DATABASE_URL ?? config.DATABASE_URL);
  await pooled?.end();
  await direct?.end();
  await checkRedis(config);
  await checkIntegrations(config);
  const failures = results.filter((item) => item.level === "FAIL").length;
  const warnings = results.filter((item) => item.level === "WARN").length;
  console.log(`\n${failures} failures, ${warnings} warnings`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
