import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { databaseTargetId } from "../../src/core/database/connection.js";

const jwtKey = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const fileEnv: Record<string, string | undefined> = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};

function setting(name: string): string | undefined {
  const value = process.env[name] ?? fileEnv[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export const testDatabaseUrl = setting("TEST_DATABASE_URL") ?? "postgresql://app:app_local_dev@localhost:5432/plataforma_test";
export const testDirectDatabaseUrl = setting("TEST_DIRECT_DATABASE_URL") ?? testDatabaseUrl;
export const testRedisUrl = setting("TEST_REDIS_URL") ?? "redis://localhost:6379/15";
const testDatabaseAllowReset = setting("TEST_DATABASE_ALLOW_RESET") === "true";

export function assertSafeTestDatabase(): void {
  const protectedUrls = [setting("DATABASE_URL"), setting("DIRECT_DATABASE_URL")].filter((value): value is string => value !== undefined);
  const testTargets = new Set([databaseTargetId(testDatabaseUrl), databaseTargetId(testDirectDatabaseUrl)]);
  for (const url of protectedUrls) {
    const target = databaseTargetId(url);
    if (target && testTargets.has(target)) {
      throw new Error("TEST_DATABASE_URL points to the same database as DATABASE_URL. Tests wipe their database, use a dedicated test database.");
    }
  }
  const databaseName = new URL(testDatabaseUrl).pathname.replace(/^\//, "");
  if (!/test/i.test(databaseName) && !testDatabaseAllowReset) {
    throw new Error("The test database name must contain 'test', or set TEST_DATABASE_ALLOW_RESET=true for a dedicated test project (for example a separate Supabase project).");
  }
}

export const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_ENV: "test",
  LOG_LEVEL: process.env["TEST_LOG_LEVEL"] ?? "silent",
  PUBLIC_API_URL: "http://api.test.local",
  WEB_APP_URL: "http://app.test.local",
  CORS_ALLOWED_ORIGINS: "http://app.test.local",
  API_DOCS_ENABLED: "true",
  METRICS_TOKEN: "test-metrics-token-0123456789abcdef",
  DATABASE_URL: testDatabaseUrl,
  DIRECT_DATABASE_URL: testDirectDatabaseUrl,
  DATABASE_SSL_MODE: setting("TEST_DATABASE_SSL_MODE") ?? "auto",
  DATABASE_POOL_MAX: "5",
  REDIS_URL: testRedisUrl,
  REDIS_KEY_PREFIX: "pe-test:",
  JWT_ISSUER: "http://api.test.local",
  JWT_AUDIENCE: "plataforma-educativa-test",
  JWT_SIGNING_KEYS: `testkey:${jwtKey}`,
  ENCRYPTION_KEYS: `testenc:${randomBytes(32).toString("base64")}`,
  SECRETS_PEPPER: randomBytes(48).toString("base64url"),
  COOKIE_SECURE: "false",
  ARGON2_MEMORY_KIB: "1024",
  ARGON2_ITERATIONS: "1",
  MAIL_PROVIDER: "memory",
  MAIL_FROM: "Plataforma Test <test@example.com>",
  STORAGE_PROVIDER: "local",
  STORAGE_LOCAL_DIR: "./storage/test",
  OAUTH_REDIRECT_ALLOWLIST: "http://app.test.local/auth/callback,com.plataforma.app://oauth",
  ANTIVIRUS_PROVIDER: "disabled",
  FILE_SCAN_REQUIRED: "false",
  SCHEDULER_ENABLED: "false",
  PRIVACY_DELETION_GRACE_DAYS: "14",
};

export function applyTestEnv(): void {
  for (const [key, value] of Object.entries(testEnv)) process.env[key] = value;
}
