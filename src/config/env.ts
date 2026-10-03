import { z } from "zod";
import { databaseTargetId, isLocalDatabaseHost, resolveDatabaseConnection, supabaseProjectRef } from "../core/database/connection.js";

const booleanString = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const csvWithDefault = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );

const csv = csvWithDefault("");

const trustProxySchema = z
  .string()
  .default("false")
  .transform((value): boolean | number | string[] => {
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^\d+$/.test(value)) return Number(value);
    return value.split(",").map((item) => item.trim());
  });

const keyringEntry = /^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9+/=_-]+$/;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_HOST: z.string().default("0.0.0.0"),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOG_PRETTY: booleanString.default(false),
  TRUST_PROXY: trustProxySchema,
  PUBLIC_API_URL: z.url(),
  WEB_APP_URL: z.url(),
  CORS_ALLOWED_ORIGINS: csv,
  API_DOCS_ENABLED: booleanString.default(false),
  METRICS_TOKEN: z.string().min(24).optional(),
  LOAD_SHEDDING_ENABLED: booleanString.default(true),
  LOAD_SHEDDING_MAX_EVENT_LOOP_DELAY_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  LOAD_SHEDDING_MAX_EVENT_LOOP_UTILIZATION: z.coerce.number().gt(0).max(1).default(0.98),
  LOAD_SHEDDING_SAMPLE_INTERVAL_MS: z.coerce.number().int().min(20).max(60_000).default(1000),
  LOAD_SHEDDING_SUSTAINED_SAMPLES: z.coerce.number().int().min(1).max(60).default(3),
  REALTIME_REVALIDATE_INTERVAL_MS: z.coerce.number().int().min(5000).max(3_600_000).default(60_000),

  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(15000),
  DATABASE_LOG_QUERIES: booleanString.default(false),
  DATABASE_SSL_MODE: z.enum(["auto", "disable", "require", "verify-full"]).default("auto"),
  DATABASE_SSL_CA_BASE64: z.string().optional(),
  DATABASE_POOLER: z.enum(["auto", "true", "false"]).default("auto"),

  REDIS_URL: z.string().min(1),
  REDIS_KEY_PREFIX: z.string().regex(/^[a-z0-9:_-]+$/).default("pe:"),
  REDIS_PROTOCOL: z.enum(["2", "3"]).default("2").transform((value) => Number(value) as 2 | 3),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(2000),

  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  JWT_SIGNING_KEYS: z.string().min(1),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  SESSION_IDLE_TIMEOUT_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(60).default(10),

  ENCRYPTION_KEYS: z.string().min(1),
  SECRETS_PEPPER: z.string().min(32),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: booleanString.optional(),
  COOKIE_SAME_SITE: z.enum(["strict", "lax", "none"]).default("strict"),

  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(64).default(12),
  PASSWORD_BREACH_CHECK: booleanString.default(false),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).default(19456),
  ARGON2_ITERATIONS: z.coerce.number().int().min(1).default(2),

  REGISTRATION_ENABLED: booleanString.default(true),

  MAIL_PROVIDER: z.enum(["console", "memory", "resend"]).default("console"),
  MAIL_FROM: z.string().min(3),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),

  PUSH_FCM_ENABLED: booleanString.default(false),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),
  FCM_PRIVATE_KEY_BASE64: z.string().optional(),
  PUSH_WEB_ENABLED: booleanString.default(false),
  VAPID_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/).optional(),
  VAPID_PRIVATE_KEY: z.string().regex(/^[A-Za-z0-9_-]{40,50}$/).optional(),
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/).optional(),
  WEB_PUSH_ALLOWED_HOSTS: csvWithDefault("fcm.googleapis.com,updates.push.services.mozilla.com,push.services.mozilla.com,web.push.apple.com,*.push.apple.com,*.notify.windows.com"),

  STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanString.default(false),
  FILE_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),

  ANTIVIRUS_PROVIDER: z.enum(["clamav", "disabled"]).default("clamav"),
  FILE_SCAN_REQUIRED: booleanString.default(true),
  CLAMAV_HOST: z.string().default("127.0.0.1"),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
  ANTIVIRUS_MAX_SCAN_BYTES: z.coerce.number().int().min(1024).default(209_715_200),

  PRIVACY_EXPORT_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  PRIVACY_DELETION_GRACE_DAYS: z.coerce.number().int().min(0).max(90).default(14),
  REPORT_EXPORT_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),

  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).default(365),
  AUDIT_SECURITY_RETENTION_DAYS: z.coerce.number().int().min(90).default(1825),
  ACTIVITY_RETENTION_DAYS: z.coerce.number().int().min(30).default(730),
  NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(30).default(365),

  OAUTH_REDIRECT_ALLOWLIST: csv,
  OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  OAUTH_MICROSOFT_CLIENT_ID: z.string().optional(),
  OAUTH_MICROSOFT_CLIENT_SECRET: z.string().optional(),
  OAUTH_MICROSOFT_TENANT: z.string().default("common"),
  OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),

  CALENDAR_SYNC_ENABLED: booleanString.default(false),
  CALENDAR_SYNC_WINDOW_DAYS: z.coerce.number().int().min(1).max(365).default(60),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(5),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  SCHEDULER_ENABLED: booleanString.default(true),
  KEY_ROTATION_BATCH_SIZE: z.coerce.number().int().min(10).max(5000).default(200),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface KeyringEntry {
  id: string;
  material: string;
}

export interface AppConfig extends RawEnv {
  isProduction: boolean;
  isTest: boolean;
  isDevelopment: boolean;
  cookieSecure: boolean;
  jwtKeys: KeyringEntry[];
  encryptionKeys: KeyringEntry[];
}

function parseKeyring(name: string, value: string): KeyringEntry[] {
  const entries = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (entries.length === 0) {
    throw new Error(`${name} must contain at least one key`);
  }
  const seen = new Set<string>();
  return entries.map((entry) => {
    if (!keyringEntry.test(entry)) {
      throw new Error(`${name} entries must use the format keyId:base64Material`);
    }
    const separator = entry.indexOf(":");
    const id = entry.slice(0, separator);
    const material = entry.slice(separator + 1);
    if (seen.has(id)) {
      throw new Error(`${name} contains duplicated key id ${id}`);
    }
    seen.add(id);
    return { id, material };
  });
}

function assertProductionSafety(config: AppConfig): void {
  const problems: string[] = [];
  if (config.MAIL_PROVIDER !== "resend") problems.push("MAIL_PROVIDER must be a real provider");
  if (config.MAIL_PROVIDER === "resend" && !config.RESEND_API_KEY) problems.push("RESEND_API_KEY is required");
  if (config.STORAGE_PROVIDER === "local") problems.push("STORAGE_PROVIDER=local is not allowed");
  if (config.CORS_ALLOWED_ORIGINS.some((origin) => origin === "*" || origin === "null")) {
    problems.push("CORS_ALLOWED_ORIGINS cannot contain * or null");
  }
  if (config.CORS_ALLOWED_ORIGINS.some((origin) => origin.startsWith("http://"))) {
    problems.push("CORS_ALLOWED_ORIGINS must use https in production");
  }
  if (!config.PUBLIC_API_URL.startsWith("https://")) problems.push("PUBLIC_API_URL must use https");
  if (!config.WEB_APP_URL.startsWith("https://")) problems.push("WEB_APP_URL must use https");
  if (config.OAUTH_REDIRECT_ALLOWLIST.some((uri) => uri.startsWith("http://"))) problems.push("OAUTH_REDIRECT_ALLOWLIST must use https or an app scheme");
  if (config.TRUST_PROXY === true) problems.push("TRUST_PROXY=true trusts every hop, use the number of proxies or their addresses");
  if (config.LOAD_SHEDDING_ENABLED === false) problems.push("LOAD_SHEDDING_ENABLED cannot be false");
  if (!config.cookieSecure) problems.push("COOKIE_SECURE cannot be false");
  if (config.COOKIE_SAME_SITE === "none" && config.CORS_ALLOWED_ORIGINS.length === 0) problems.push("COOKIE_SAME_SITE=none requires explicit CORS origins");
  if (config.TRUST_PROXY === false) problems.push("TRUST_PROXY must be configured behind the load balancer");
  if (!config.METRICS_TOKEN) problems.push("METRICS_TOKEN is required");
  if (config.ARGON2_MEMORY_KIB < 19456) problems.push("ARGON2_MEMORY_KIB must be at least 19456");
  if (config.DATABASE_SSL_MODE === "disable") problems.push("DATABASE_SSL_MODE cannot be disable");
  for (const [name, url] of [["DATABASE_URL", config.DATABASE_URL], ["DIRECT_DATABASE_URL", config.DIRECT_DATABASE_URL]] as const) {
    if (!url) continue;
    try {
      const resolved = resolveDatabaseConnection({ url, poolMax: 1, statementTimeoutMs: 0, sslMode: config.DATABASE_SSL_MODE, sslCaBase64: config.DATABASE_SSL_CA_BASE64 });
      if (resolved.effectiveSslMode === "disable") problems.push(`${name} must use TLS; set DATABASE_SSL_MODE=require or verify-full`);
    } catch (error) {
      problems.push(`${name} is invalid: ${error instanceof Error ? error.message : "unparseable"}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Unsafe production configuration: ${problems.join("; ")}`);
  }
}

function assertDatabaseTargets(config: AppConfig): void {
  const urls = [["DATABASE_URL", config.DATABASE_URL], ["DIRECT_DATABASE_URL", config.DIRECT_DATABASE_URL]] as const;
  for (const [name, url] of urls) {
    if (!url) continue;
    const resolved = resolveDatabaseConnection({ url, poolMax: 1, statementTimeoutMs: 0, sslMode: config.DATABASE_SSL_MODE, sslCaBase64: config.DATABASE_SSL_CA_BASE64 });
    if (!isLocalDatabaseHost(resolved.host) && resolved.effectiveSslMode === "disable") {
      throw new Error(`${name} must use TLS for the remote host ${resolved.host}; set DATABASE_SSL_MODE=require (or verify-full) and do not use sslmode=disable in the URL`);
    }
  }
  const directRef = config.DIRECT_DATABASE_URL ? supabaseProjectRef(config.DIRECT_DATABASE_URL) : null;
  const pooledRef = supabaseProjectRef(config.DATABASE_URL);
  if (config.DIRECT_DATABASE_URL && (directRef !== null || pooledRef !== null) && databaseTargetId(config.DATABASE_URL) !== databaseTargetId(config.DIRECT_DATABASE_URL)) {
    throw new Error("DATABASE_URL and DIRECT_DATABASE_URL must point to the same Supabase project");
  }
}

function withoutEmptyValues(source: NodeJS.ProcessEnv): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim().length > 0) output[key] = value.trim();
  }
  return output;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(withoutEmptyValues(source));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment configuration -> ${fields.join("; ")}`);
  }
  const env = parsed.data;
  const isProduction = env.APP_ENV === "production" || env.APP_ENV === "staging";
  const config: AppConfig = {
    ...env,
    isProduction,
    isTest: env.APP_ENV === "test",
    isDevelopment: env.APP_ENV === "development",
    cookieSecure: env.COOKIE_SECURE ?? isProduction,
    jwtKeys: parseKeyring("JWT_SIGNING_KEYS", env.JWT_SIGNING_KEYS),
    encryptionKeys: parseKeyring("ENCRYPTION_KEYS", env.ENCRYPTION_KEYS),
  };
  if (config.COOKIE_SAME_SITE === "none" && !config.cookieSecure) {
    throw new Error("COOKIE_SAME_SITE=none requires COOKIE_SECURE=true");
  }
  if (config.MAIL_PROVIDER === "memory" && !config.isTest) {
    throw new Error("MAIL_PROVIDER=memory is only allowed in tests");
  }
  if (config.FILE_SCAN_REQUIRED && config.ANTIVIRUS_PROVIDER === "disabled") {
    throw new Error("FILE_SCAN_REQUIRED=true requires an antivirus provider; set ANTIVIRUS_PROVIDER=clamav or explicitly set FILE_SCAN_REQUIRED=false");
  }
  if (config.PUSH_FCM_ENABLED && (!config.FCM_PROJECT_ID || !config.FCM_CLIENT_EMAIL || !config.FCM_PRIVATE_KEY_BASE64)) {
    throw new Error("PUSH_FCM_ENABLED=true requires FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY_BASE64");
  }
  if (config.PUSH_WEB_ENABLED && (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY || !config.VAPID_SUBJECT)) {
    throw new Error("PUSH_WEB_ENABLED=true requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT");
  }
  assertDatabaseTargets(config);
  if (isProduction) {
    assertProductionSafety(config);
  }
  return config;
}
