import { createContainer } from "../app/container.js";
import { closeInfrastructure, createInfrastructure } from "../app/infrastructure.js";
import { loadConfig } from "../config/env.js";
import { assertDatabaseSessionTimeZone } from "../core/database/prisma.js";
import { DemoEnvironmentError, demoAttemptStates, readDemoRegistry, removeDemoData, resolveDemoTarget, seedDemoData } from "./demo-data.js";

const commands = ["seed", "reset", "remove", "status"] as const;
type Command = (typeof commands)[number];

function parseCommand(argument: string | undefined): Command {
  const command = (argument ?? "seed") as Command;
  if (!commands.includes(command)) throw new DemoEnvironmentError(`Unknown command ${argument}. Use one of: ${commands.join(", ")}`);
  return command;
}

async function main() {
  const command = parseCommand(process.argv[2]);
  const config = loadConfig();
  const target = resolveDemoTarget(config);
  const infra = createInfrastructure(config);
  const container = createContainer(infra);
  try {
    await assertDatabaseSessionTimeZone(container.db);
    console.log(`Demo database: ${target.targetId} (${target.local ? "local" : "explicitly allowed remote"})`);
    if (command === "remove" || command === "reset") {
      const removed = await removeDemoData(container);
      console.log(`Removed demo data: ${removed.users} users, ${removed.institutions} institutions, ${removed.courses} courses, ${removed.files} files`);
    }
    if (command === "seed" || command === "reset") {
      const summary = await seedDemoData(container, target);
      console.log(`Demo data ready in ${target.targetId}. These accounts are demo data only:`);
      for (const [role, email] of Object.entries(summary.accounts)) console.log(`  ${role.padEnd(18)} ${email}`);
      console.log(target.local && !process.env["DEMO_PASSWORD"] ? `  password           ${summary.password} (local default, set DEMO_PASSWORD to change it)` : "  password           value of DEMO_PASSWORD");
      console.log(`Institutions: demo=${summary.institutions.demo} external=${summary.institutions.external}`);
      for (const [name, course] of Object.entries(summary.courses)) console.log(`Course ${name.padEnd(12)} ${course.id} ${course.status}`);
      console.log(`Program ${summary.programId}`);
    }
    if (command === "status" || command === "seed" || command === "reset") {
      const registry = await readDemoRegistry(container.db);
      console.log(`Demo registry: ${registry ? `${registry.userIds.length} users, ${registry.institutionIds.length} institutions` : "empty"}`);
      console.log(`Demo learner state: ${JSON.stringify(await demoAttemptStates(container))}`);
    }
  } finally {
    await closeInfrastructure(infra);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof DemoEnvironmentError ? `Refused: ${error.message}` : error);
  process.exit(1);
});
