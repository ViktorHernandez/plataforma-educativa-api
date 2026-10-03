import { execSync } from "node:child_process";
import pg from "pg";
import { resolveDatabaseConnection } from "../src/core/database/connection.js";
import { assertSafeTestDatabase, testDatabaseUrl, testDirectDatabaseUrl } from "./helpers/test-env.js";

const resetOwnedObjects = `
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', item.tablename);
  END LOOP;
  FOR item IN
    SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e' AND pg_get_userbyid(t.typowner) = current_user
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', item.typname);
  END LOOP;
END
$$;`;

export default async function setup(): Promise<void> {
  assertSafeTestDatabase();
  const { poolConfig } = resolveDatabaseConnection({ url: testDirectDatabaseUrl, poolMax: 1, statementTimeoutMs: 0 });
  const client = new pg.Client(poolConfig);
  await client.connect();
  try {
    await client.query(resetOwnedObjects);
  } finally {
    await client.end();
  }
  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: testDatabaseUrl, DIRECT_DATABASE_URL: testDirectDatabaseUrl },
  });
}
