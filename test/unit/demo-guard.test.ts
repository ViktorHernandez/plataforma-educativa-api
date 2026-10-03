import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { resolveDemoTarget } from "../../src/scripts/demo-data.js";
import { testEnv } from "../helpers/test-env.js";

const local = loadConfig({ ...testEnv, APP_ENV: "development", NODE_ENV: "development", MAIL_PROVIDER: "console", DATABASE_URL: "postgresql://app:pw@localhost:5432/plataforma_dev", DIRECT_DATABASE_URL: "postgresql://app:pw@localhost:5432/plataforma_dev" });
const ref = "abcdefghijklmnopqrst";
const supabase = loadConfig({
  ...testEnv,
  APP_ENV: "development",
  NODE_ENV: "development",
  MAIL_PROVIDER: "console",
  DATABASE_SSL_MODE: "require",
  DATABASE_URL: `postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
  DIRECT_DATABASE_URL: `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`,
});

describe("demo data guard", () => {
  it("writes to a local database outside production with the local default password", () => {
    const target = resolveDemoTarget(local, {});
    expect(target.local).toBe(true);
    expect(target.targetId).toBe("localhost:5432/plataforma_dev");
    expect(() => resolveDemoTarget({ ...local, APP_ENV: "staging", isProduction: true }, {})).toThrow(/APP_ENV/);
    expect(() => resolveDemoTarget({ ...local, NODE_ENV: "production" }, {})).toThrow(/APP_ENV/);
    expect(() => resolveDemoTarget(local, { DEMO_PASSWORD: "short" })).toThrow(/at least 12/);
  });

  it("only writes to a Supabase project that is named explicitly, never to a shared pooler host", () => {
    expect(() => resolveDemoTarget(supabase, {})).toThrow(`DEMO_ALLOW_DATABASE_TARGET=supabase:${ref}`);
    expect(() => resolveDemoTarget(supabase, { DEMO_ALLOW_DATABASE_TARGET: "aws-0-us-east-1.pooler.supabase.com", DEMO_PASSWORD: "Another-Demo-Password-1" })).toThrow(/DEMO_ALLOW_DATABASE_TARGET/);
    expect(() => resolveDemoTarget(supabase, { DEMO_ALLOW_DATABASE_TARGET: "supabase:zyxwvutsrqponmlkjihg", DEMO_PASSWORD: "Another-Demo-Password-1" })).toThrow(/DEMO_ALLOW_DATABASE_TARGET/);
    expect(() => resolveDemoTarget(supabase, { DEMO_ALLOW_DATABASE_TARGET: `supabase:${ref}` })).toThrow(/DEMO_PASSWORD/);
    const target = resolveDemoTarget(supabase, { DEMO_ALLOW_DATABASE_TARGET: `supabase:${ref}`, DEMO_PASSWORD: "Another-Demo-Password-1" });
    expect(target).toMatchObject({ local: false, targetId: `supabase:${ref}`, allowExistingData: false });
    expect(resolveDemoTarget(supabase, { DEMO_ALLOW_DATABASE_TARGET: `supabase:${ref}`, DEMO_PASSWORD: "Another-Demo-Password-1", DEMO_ALLOW_EXISTING_DATA: "true" }).allowExistingData).toBe(true);
  });
});
