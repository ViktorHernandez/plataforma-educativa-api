import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { generateVapidKeys } from "../../src/core/push/web-push.js";
import { testEnv } from "../helpers/test-env.js";

const { DATABASE_SSL_MODE: _localSslMode, DIRECT_DATABASE_URL: _localDirectUrl, DATABASE_URL: _localUrl, REDIS_URL: _localRedis, ...portableTestEnv } = testEnv;

const productionBase = {
  ...portableTestEnv,
  APP_ENV: "production",
  NODE_ENV: "production",
  PUBLIC_API_URL: "https://api.example.com",
  WEB_APP_URL: "https://app.example.com",
  CORS_ALLOWED_ORIGINS: "https://app.example.com",
  OAUTH_REDIRECT_ALLOWLIST: "https://app.example.com/auth/callback,com.plataforma.app://oauth",
  MAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_placeholder_for_configuration_test",
  STORAGE_PROVIDER: "s3",
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY_ID: "placeholder",
  S3_SECRET_ACCESS_KEY: "placeholder",
  TRUST_PROXY: "1",
  ARGON2_MEMORY_KIB: "19456",
  ARGON2_ITERATIONS: "2",
  COOKIE_SECURE: "true",
  DATABASE_URL: "postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
  DIRECT_DATABASE_URL: "postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
  REDIS_URL: "rediss://default:pw@redis.example.com:6379",
  ANTIVIRUS_PROVIDER: "clamav",
  FILE_SCAN_REQUIRED: "true",
};

describe("antivirus policy", () => {
  it("never starts with scanning required but the antivirus disabled", () => {
    expect(() => loadConfig({ ...testEnv, ANTIVIRUS_PROVIDER: "disabled", FILE_SCAN_REQUIRED: "true" })).toThrow(/FILE_SCAN_REQUIRED/);
    expect(() => loadConfig({ ...productionBase, ANTIVIRUS_PROVIDER: "disabled" })).toThrow(/FILE_SCAN_REQUIRED/);
    const { FILE_SCAN_REQUIRED: _omitted, ...withDefault } = { ...productionBase, ANTIVIRUS_PROVIDER: "disabled" };
    expect(() => loadConfig(withDefault)).toThrow(/FILE_SCAN_REQUIRED/);
  });

  it("accepts a production configuration with ClamAV and Supabase", () => {
    const config = loadConfig(productionBase);
    expect(config.isProduction).toBe(true);
    expect(config.ANTIVIRUS_PROVIDER).toBe("clamav");
    expect(config.DATABASE_SSL_MODE).toBe("auto");
  });

  it("refuses unencrypted database connections in production", () => {
    expect(() => loadConfig({ ...productionBase, DATABASE_SSL_MODE: "disable" })).toThrow(/DATABASE_SSL_MODE/);
    expect(() => loadConfig({ ...productionBase, DATABASE_URL: "postgresql://app:pw@db.internal.example.com:5432/app" })).toThrow(/DATABASE_URL must use TLS/);
    expect(() => loadConfig({ ...productionBase, DATABASE_URL: "postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=disable" })).toThrow(/DATABASE_URL must use TLS/);
    expect(() => loadConfig({ ...productionBase, DIRECT_DATABASE_URL: "postgresql://app:pw@db.internal.example.com:5432/app" })).toThrow(/DIRECT_DATABASE_URL must use TLS/);
    expect(loadConfig({ ...productionBase, DATABASE_URL: "postgresql://app:pw@db.internal.example.com:5432/app?sslmode=require", DIRECT_DATABASE_URL: "postgresql://app:pw@db.internal.example.com:5432/app?sslmode=require" }).isProduction).toBe(true);
    expect(loadConfig({ ...productionBase, DATABASE_SSL_MODE: "require", DATABASE_URL: "postgresql://app:pw@db.internal.example.com:5432/app", DIRECT_DATABASE_URL: "postgresql://app:pw@db.internal.example.com:5432/app" }).isProduction).toBe(true);
  });

});

describe("database targets", () => {
  const ref = "abcdefghijklmnopqrst";
  const pooled = `postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
  const direct = `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`;

  it("never talks to a remote database without TLS, even in development", () => {
    const development = { ...testEnv, APP_ENV: "development", NODE_ENV: "development", MAIL_PROVIDER: "console", DATABASE_URL: pooled, DIRECT_DATABASE_URL: direct };
    expect(() => loadConfig({ ...development, DATABASE_SSL_MODE: "disable" })).toThrow(/DATABASE_URL must use TLS/);
    expect(() => loadConfig({ ...development, DATABASE_SSL_MODE: "auto", DIRECT_DATABASE_URL: "postgresql://app:pw@db.example.net:5432/app" })).toThrow(/DIRECT_DATABASE_URL must use TLS|same Supabase project/);
    expect(loadConfig({ ...development, DATABASE_SSL_MODE: "require" }).DATABASE_SSL_MODE).toBe("require");
    expect(loadConfig({ ...development, DATABASE_SSL_MODE: "auto" }).DATABASE_SSL_MODE).toBe("auto");
    expect(loadConfig({ ...testEnv, DATABASE_SSL_MODE: "disable", DATABASE_URL: "postgresql://app:pw@localhost:5432/plataforma_dev", DIRECT_DATABASE_URL: "postgresql://app:pw@127.0.0.1:5432/plataforma_dev" }).isTest).toBe(true);
  });

  it("requires both URLs to reach the same Supabase project", () => {
    const development = { ...testEnv, APP_ENV: "development", NODE_ENV: "development", MAIL_PROVIDER: "console", DATABASE_SSL_MODE: "require", DATABASE_URL: pooled };
    expect(loadConfig({ ...development, DIRECT_DATABASE_URL: direct }).DIRECT_DATABASE_URL).toBe(direct);
    expect(loadConfig({ ...development, DIRECT_DATABASE_URL: `postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres` }).isDevelopment).toBe(true);
    expect(() => loadConfig({ ...development, DIRECT_DATABASE_URL: "postgresql://postgres:pw@db.zyxwvutsrqponmlkjihg.supabase.co:5432/postgres" })).toThrow(/same Supabase project/);
  });
});

describe("production hardening", () => {
  it("refuses insecure links, open proxy trust and disabled load shedding", () => {
    expect(() => loadConfig({ ...productionBase, WEB_APP_URL: "http://app.example.com" })).toThrow(/WEB_APP_URL/);
    expect(() => loadConfig({ ...productionBase, OAUTH_REDIRECT_ALLOWLIST: "http://app.example.com/callback" })).toThrow(/OAUTH_REDIRECT_ALLOWLIST/);
    expect(loadConfig({ ...productionBase, OAUTH_REDIRECT_ALLOWLIST: "https://app.example.com/callback,com.plataforma.app://oauth" }).OAUTH_REDIRECT_ALLOWLIST).toHaveLength(2);
    expect(() => loadConfig({ ...productionBase, TRUST_PROXY: "true" })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...productionBase, LOAD_SHEDDING_ENABLED: "false" })).toThrow(/LOAD_SHEDDING/);
    expect(loadConfig(productionBase).LOAD_SHEDDING_SUSTAINED_SAMPLES).toBe(3);
  });
});

describe("push provider configuration", () => {
  it("requires credentials for every enabled provider", () => {
    expect(() => loadConfig({ ...testEnv, PUSH_FCM_ENABLED: "true" })).toThrow(/FCM/);
    expect(() => loadConfig({ ...testEnv, PUSH_WEB_ENABLED: "true" })).toThrow(/VAPID/);
    const vapid = generateVapidKeys();
    const config = loadConfig({ ...testEnv, PUSH_WEB_ENABLED: "true", VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:soporte@example.com" });
    expect(config.PUSH_WEB_ENABLED).toBe(true);
    expect(config.WEB_PUSH_ALLOWED_HOSTS).toContain("fcm.googleapis.com");
  });
});

describe("retention configuration", () => {
  it("rejects retention windows that are too short", () => {
    expect(() => loadConfig({ ...testEnv, AUDIT_RETENTION_DAYS: "5" })).toThrow();
    expect(() => loadConfig({ ...testEnv, AUDIT_SECURITY_RETENTION_DAYS: "30" })).toThrow();
    expect(loadConfig(testEnv).AUDIT_SECURITY_RETENTION_DAYS).toBeGreaterThanOrEqual(loadConfig(testEnv).AUDIT_RETENTION_DAYS);
  });
});
