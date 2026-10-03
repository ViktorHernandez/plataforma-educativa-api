import type { PoolConfig } from "pg";

export type DatabaseSslMode = "auto" | "disable" | "require" | "verify-full";
export type DatabasePoolerMode = "auto" | "true" | "false";

export interface DatabaseConnectionSettings {
  url: string;
  poolMax: number;
  statementTimeoutMs: number;
  sslMode?: DatabaseSslMode;
  sslCaBase64?: string;
  pooler?: DatabasePoolerMode;
  applicationName?: string;
}

export interface ResolvedConnection {
  poolConfig: PoolConfig;
  effectiveSslMode: Exclude<DatabaseSslMode, "auto">;
  usesPooler: boolean;
  host: string;
}

const connectionParametersHandledHere = ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat", "pgbouncer", "connection_limit", "pool_timeout", "statement_cache_size"];

const supabaseHostPattern = /\.supabase\.(co|com)$/i;
const supabasePoolerPattern = /\.pooler\.supabase\.com$/i;

function sslModeFromUrl(value: string | null): Exclude<DatabaseSslMode, "auto"> | null {
  switch (value) {
    case null:
      return null;
    case "disable":
      return "disable";
    case "allow":
    case "prefer":
    case "require":
    case "no-verify":
      return "require";
    case "verify-ca":
    case "verify-full":
      return "verify-full";
    default:
      throw new Error(`Unsupported sslmode "${value}" in DATABASE_URL`);
  }
}

export function isSupabaseHost(host: string): boolean {
  return supabaseHostPattern.test(host);
}

const localDatabaseHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal", "postgres"]);

export function isLocalDatabaseHost(host: string): boolean {
  return localDatabaseHosts.has(host.toLowerCase());
}

export function supabaseProjectRef(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host);
  if (direct) return direct[1]!;
  if (supabasePoolerPattern.test(host)) {
    const user = decodeURIComponent(parsed.username);
    const separator = user.lastIndexOf(".");
    return separator > 0 ? user.slice(separator + 1).toLowerCase() : null;
  }
  return null;
}

export function databaseTargetId(url: string): string | null {
  const ref = supabaseProjectRef(url);
  if (ref) return `supabase:${ref}`;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}/${parsed.pathname.replace(/^\//, "")}`;
  } catch {
    return null;
  }
}

export function resolveDatabaseConnection(settings: DatabaseConnectionSettings): ResolvedConnection {
  let parsed: URL;
  try {
    parsed = new URL(settings.url);
  } catch {
    throw new Error("DATABASE_URL is not a valid connection URL");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use the postgresql:// scheme");
  }
  const host = parsed.hostname;
  const urlSslMode = sslModeFromUrl(parsed.searchParams.get("sslmode"));
  for (const name of connectionParametersHandledHere) parsed.searchParams.delete(name);

  const requested = settings.sslMode ?? "auto";
  const effectiveSslMode: Exclude<DatabaseSslMode, "auto"> =
    requested !== "auto" ? requested : (urlSslMode ?? (isSupabaseHost(host) ? "require" : "disable"));

  const poolerSetting = settings.pooler ?? "auto";
  const usesPooler = poolerSetting === "auto" ? supabasePoolerPattern.test(host) || parsed.port === "6543" : poolerSetting === "true";

  let ssl: PoolConfig["ssl"];
  if (effectiveSslMode === "disable") {
    ssl = false;
  } else if (effectiveSslMode === "require") {
    ssl = { rejectUnauthorized: false };
  } else {
    const ca = settings.sslCaBase64 ? Buffer.from(settings.sslCaBase64, "base64").toString("utf8") : undefined;
    if (ca !== undefined && !ca.includes("BEGIN CERTIFICATE")) throw new Error("DATABASE_SSL_CA_BASE64 must contain a base64 encoded PEM certificate");
    ssl = { rejectUnauthorized: true, ...(ca ? { ca } : {}), servername: host };
  }

  const poolConfig: PoolConfig = {
    connectionString: parsed.toString(),
    max: settings.poolMax,
    ssl,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: settings.applicationName ?? "plataforma-educativa-api",
  };
  if (!usesPooler) {
    poolConfig.options = "-c TimeZone=UTC";
    if (settings.statementTimeoutMs > 0) poolConfig.statement_timeout = settings.statementTimeoutMs;
  }
  return { poolConfig, effectiveSslMode, usesPooler, host };
}

export const REQUIRED_SESSION_TIMEZONE = "UTC";

export function isUtcTimeZone(value: string): boolean {
  return ["utc", "etc/utc", "etc/universal", "universal", "zulu", "etc/zulu", "gmt", "etc/gmt", "z"].includes(value.trim().toLowerCase());
}
