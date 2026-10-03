import { describe, expect, it } from "vitest";
import { databaseTargetId, isLocalDatabaseHost, resolveDatabaseConnection, supabaseProjectRef } from "../../src/core/database/connection.js";

const transactionPooler = "postgresql://postgres.abcdefghijklmnop:secret-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
const sessionPooler = "postgresql://postgres.abcdefghijklmnop:secret-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
const direct = "postgresql://postgres:secret-password@db.abcdefghijklmnop.supabase.co:5432/postgres";
const local = "postgresql://app:app_local_dev@localhost:5432/plataforma_dev";

describe("Supabase compatible database connections", () => {
  it("uses TLS without sending startup parameters through the transaction pooler", () => {
    const resolved = resolveDatabaseConnection({ url: transactionPooler, poolMax: 5, statementTimeoutMs: 15000 });
    expect(resolved.usesPooler).toBe(true);
    expect(resolved.effectiveSslMode).toBe("require");
    expect(resolved.poolConfig.ssl).toEqual({ rejectUnauthorized: false });
    expect(resolved.poolConfig.statement_timeout).toBeUndefined();
    expect(resolved.poolConfig.options).toBeUndefined();
    expect(resolved.poolConfig.max).toBe(5);
  });

  it("treats the session pooler as a pooler and the direct host as a plain connection", () => {
    expect(resolveDatabaseConnection({ url: sessionPooler, poolMax: 5, statementTimeoutMs: 15000 }).usesPooler).toBe(true);
    const directConnection = resolveDatabaseConnection({ url: direct, poolMax: 5, statementTimeoutMs: 15000 });
    expect(directConnection.usesPooler).toBe(false);
    expect(directConnection.effectiveSslMode).toBe("require");
    expect(directConnection.poolConfig.statement_timeout).toBe(15000);
    expect(directConnection.poolConfig.options).toBe("-c TimeZone=UTC");
  });

  it("keeps local databases without TLS and honours explicit settings", () => {
    const resolved = resolveDatabaseConnection({ url: local, poolMax: 10, statementTimeoutMs: 5000 });
    expect(resolved.effectiveSslMode).toBe("disable");
    expect(resolved.poolConfig.ssl).toBe(false);
    const forced = resolveDatabaseConnection({ url: local, poolMax: 10, statementTimeoutMs: 5000, sslMode: "require", pooler: "true" });
    expect(forced.effectiveSslMode).toBe("require");
    expect(forced.usesPooler).toBe(true);
  });

  it("removes libpq parameters that node-postgres would reinterpret", () => {
    const resolved = resolveDatabaseConnection({ url: `${transactionPooler}?sslmode=require&pgbouncer=true&connection_limit=1&application_name=custom`, poolMax: 5, statementTimeoutMs: 0 });
    const url = new URL(resolved.poolConfig.connectionString!);
    expect(url.searchParams.has("sslmode")).toBe(false);
    expect(url.searchParams.has("pgbouncer")).toBe(false);
    expect(url.searchParams.has("connection_limit")).toBe(false);
    expect(url.searchParams.get("application_name")).toBe("custom");
    expect(resolved.poolConfig.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("verifies the server certificate with a provided CA", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";
    const resolved = resolveDatabaseConnection({ url: direct, poolMax: 5, statementTimeoutMs: 0, sslMode: "verify-full", sslCaBase64: Buffer.from(pem).toString("base64") });
    expect(resolved.poolConfig.ssl).toMatchObject({ rejectUnauthorized: true, ca: pem, servername: "db.abcdefghijklmnop.supabase.co" });
    expect(() => resolveDatabaseConnection({ url: direct, poolMax: 5, statementTimeoutMs: 0, sslMode: "verify-full", sslCaBase64: Buffer.from("not a pem").toString("base64") })).toThrow();
  });

  it("maps URL ssl modes and rejects invalid URLs", () => {
    expect(resolveDatabaseConnection({ url: `${local}?sslmode=verify-full`, poolMax: 1, statementTimeoutMs: 0 }).effectiveSslMode).toBe("verify-full");
    expect(resolveDatabaseConnection({ url: `${direct}?sslmode=disable`, poolMax: 1, statementTimeoutMs: 0 }).effectiveSslMode).toBe("disable");
    expect(() => resolveDatabaseConnection({ url: "mysql://localhost/db", poolMax: 1, statementTimeoutMs: 0 })).toThrow();
    expect(() => resolveDatabaseConnection({ url: "not a url", poolMax: 1, statementTimeoutMs: 0 })).toThrow();
  });
});

describe("database identity", () => {
  it("identifies a Supabase project through the pooler, the session pooler and the direct host", () => {
    expect(supabaseProjectRef(transactionPooler)).toBe("abcdefghijklmnop");
    expect(supabaseProjectRef(sessionPooler)).toBe("abcdefghijklmnop");
    expect(supabaseProjectRef(direct)).toBe("abcdefghijklmnop");
    expect(databaseTargetId(transactionPooler)).toBe(databaseTargetId(direct));
    expect(databaseTargetId(local)).toBe("localhost:5432/plataforma_dev");
    expect(supabaseProjectRef(local)).toBeNull();
    expect(isLocalDatabaseHost("LOCALHOST")).toBe(true);
    expect(isLocalDatabaseHost("aws-0-us-east-1.pooler.supabase.com")).toBe(false);
  });
});
