import { writeFile } from "node:fs/promises";
import { buildApp } from "../src/app/build-app.js";
import { createContainer } from "../src/app/container.js";
import { closeInfrastructure, createInfrastructure } from "../src/app/infrastructure.js";
import { loadConfig } from "../src/config/env.js";

interface OperationObject {
  summary?: string;
  tags?: string[];
  security?: unknown[];
  parameters?: Array<{ in: string; name: string }>;
  requestBody?: unknown;
  responses?: Record<string, { content?: unknown }>;
}

const redirectOperations = new Set(["GET /v1/auth/oauth/{provider}/callback", "GET /v1/integrations/calendar/{provider}/callback"]);
const methods = ["get", "post", "put", "patch", "delete"] as const;

const args = process.argv.slice(2);
const check = args.includes("--check");
const output = args.find((arg) => !arg.startsWith("--")) ?? "openapi.json";

const config = loadConfig({ ...process.env, API_DOCS_ENABLED: "true", LOG_LEVEL: "silent", SCHEDULER_ENABLED: "false" });
const infra = createInfrastructure(config);
const app = await buildApp(createContainer(infra));
await app.ready();
const spec = app.swagger() as { paths?: Record<string, Partial<Record<(typeof methods)[number], OperationObject>>> };
await writeFile(output, `${JSON.stringify(spec, null, 2)}\n`);

const problems: string[] = [];
let operations = 0;
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const method of methods) {
    const operation = item[method];
    if (!operation) continue;
    operations += 1;
    const id = `${method.toUpperCase()} ${path}`;
    if (!operation.summary) problems.push(`${id}: missing summary`);
    if (!operation.tags || operation.tags.length === 0) problems.push(`${id}: missing tags`);
    const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    for (const name of pathParams) {
      if (!operation.parameters?.some((parameter) => parameter.in === "path" && parameter.name === name)) problems.push(`${id}: path parameter ${name} is not documented`);
    }
    if (redirectOperations.has(id)) continue;
    const success = Object.entries(operation.responses ?? {}).filter(([status]) => /^2\d\d$/.test(status));
    if (success.length === 0) problems.push(`${id}: no documented success response`);
    for (const [status, response] of success) {
      if (status !== "204" && !response.content) problems.push(`${id}: response ${status} has no schema`);
    }
    if (path.startsWith("/v1/admin/") && (!operation.security || operation.security.length === 0)) problems.push(`${id}: admin operation without security requirement`);
  }
}

console.log(`OpenAPI written to ${output} (${Object.keys(spec.paths ?? {}).length} paths, ${operations} operations)`);
await app.close();
await closeInfrastructure(infra);
if (check) {
  if (problems.length > 0) {
    console.error(`OpenAPI check failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log("OpenAPI check passed");
}
