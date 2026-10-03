import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { constantTimeEqual } from "../../core/crypto/random.js";
import { notFound, unauthorized } from "../../core/http/errors.js";

type DependencyStatus = "up" | "down";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const readinessSchema = z.object({
  status: z.enum(["ok", "degraded", "unavailable"]),
  checks: z.object({
    database: z.object({ status: z.enum(["up", "down"]), latencyMs: z.number().nullable() }),
    redis: z.object({ status: z.enum(["up", "down"]), latencyMs: z.number().nullable() }),
    antivirus: z.object({ status: z.enum(["up", "down", "disabled"]), latencyMs: z.number().nullable() }),
  }),
  version: z.string(),
  uptimeSeconds: z.number(),
});

export function registerHealthRoutes(app: AppInstance, container: Container, version: string): void {
  const startedAt = Date.now();

  async function probe(check: () => Promise<unknown>): Promise<{ status: DependencyStatus; latencyMs: number | null }> {
    const begin = performance.now();
    try {
      await withTimeout(check(), 2000);
      return { status: "up", latencyMs: Math.round(performance.now() - begin) };
    } catch {
      return { status: "down", latencyMs: null };
    }
  }

  app.get(
    "/health/live",
    { logLevel: "warn", schema: { tags: ["Health"], summary: "Liveness probe", response: { 200: z.object({ status: z.literal("ok") }) } } },
    async () => ({ status: "ok" as const }),
  );

  const readiness = async () => {
    const [database, redis, antivirus] = await Promise.all([
      probe(() => container.db.$queryRaw`SELECT 1`),
      probe(() => container.redis.ping()),
      container.scanner.enabled
        ? probe(async () => {
            if (!(await container.scanner.ping())) throw new Error("antivirus unavailable");
          })
        : Promise.resolve({ status: "disabled" as const, latencyMs: null }),
    ]);
    const status = database.status === "down" ? "unavailable" : redis.status === "down" || antivirus.status === "down" ? "degraded" : "ok";
    const httpStatus: 200 | 503 = status === "unavailable" ? 503 : 200;
    return { httpStatus, body: { status, checks: { database, redis, antivirus }, version, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) } } as const;
  };

  for (const path of ["/health/ready", "/health"]) {
    app.get(
      path,
      { logLevel: "warn", schema: { tags: ["Health"], summary: "Readiness probe", response: { 200: readinessSchema, 503: readinessSchema } } },
      async (_request, reply) => {
        const result = await readiness();
        reply.code(result.httpStatus);
        return result.body;
      },
    );
  }

  app.get("/metrics", { logLevel: "warn", schema: { hide: true } }, async (request, reply) => {
    const token = container.config.METRICS_TOKEN;
    if (!token) throw notFound();
    const header = request.headers.authorization ?? "";
    if (!constantTimeEqual(header, `Bearer ${token}`)) throw unauthorized();
    reply.header("content-type", container.metrics.registry.contentType);
    return container.metrics.registry.metrics();
  });
}
