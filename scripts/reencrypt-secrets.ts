import { createContainer } from "../src/app/container.js";
import { closeInfrastructure, createInfrastructure } from "../src/app/infrastructure.js";
import { loadConfig } from "../src/config/env.js";

const infra = createInfrastructure(loadConfig());
const container = createContainer(infra);
try {
  const usage = await container.keyRotation.keyUsage();
  console.log(`Active key: ${container.encryptor.activeKey}`);
  for (const item of usage) console.log(`  ${item.column} key=${item.keyId} rows=${item.rows}`);
  const run = await container.keyRotation.runToCompletion();
  if (!run) {
    console.log("Nothing to re-encrypt, every stored secret already uses the active key");
  } else {
    console.log(`Run ${run.id}: status=${run.status} processed=${run.processed} failed=${run.failed}${run.lastError ? ` lastError=${run.lastError}` : ""}`);
    if (run.status !== "COMPLETED") process.exitCode = 1;
  }
  const after = await container.keyRotation.keyUsage();
  const stale = after.filter((item) => item.keyId !== container.encryptor.activeKey);
  console.log(stale.length === 0 ? "Old keys can now be removed from ENCRYPTION_KEYS" : "Some rows still use old keys, keep them in ENCRYPTION_KEYS");
} finally {
  await closeInfrastructure(infra);
}
