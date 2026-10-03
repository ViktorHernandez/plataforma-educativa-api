import { createContainer } from "../src/app/container.js";
import { closeInfrastructure, createInfrastructure } from "../src/app/infrastructure.js";
import { loadConfig } from "../src/config/env.js";
import { runScheduledJob, scheduledJobs } from "../src/worker/scheduler.js";

const name = process.argv[2];
if (!name || !scheduledJobs.some((job) => job.name === name)) {
  console.error(`Usage: npm run jobs:run -- <job>\nAvailable jobs: ${scheduledJobs.map((job) => job.name).join(", ")}`);
  process.exit(1);
}

const infra = createInfrastructure(loadConfig());
const container = createContainer(infra);
try {
  const result = await runScheduledJob(container, name);
  console.log(JSON.stringify({ job: name, result }, null, 2));
} finally {
  await closeInfrastructure(infra);
}
