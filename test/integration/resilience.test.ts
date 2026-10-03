import { Queue } from "bullmq";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDatabaseSessionTimeZone } from "../../src/core/database/prisma.js";
import { createBlockingRedis } from "../../src/core/redis/redis.js";
import { MAINTENANCE_QUEUE, scheduledJobs, startScheduler } from "../../src/worker/scheduler.js";
import { academicWorld, publishedCourse } from "../helpers/academic.js";
import { DEFAULT_PASSWORD, bearer, createUser, login } from "../helpers/factories.js";
import { createTestContext, json, resetState, type TestContext } from "../helpers/test-app.js";
import { testRedisUrl } from "../helpers/test-env.js";

describe("Redis outage", () => {
  let healthy: TestContext;
  let degraded: TestContext;

  beforeAll(async () => {
    healthy = await createTestContext();
    await resetState(healthy.container);
    degraded = await createTestContext({ env: { REDIS_URL: "redis://127.0.0.1:6399/0", REDIS_COMMAND_TIMEOUT_MS: "300" } });
  });

  afterAll(async () => {
    await degraded.close();
    await healthy.close();
  });

  it("keeps authentication, sessions and durable work running on PostgreSQL", async () => {
    const world = await academicWorld(healthy.app, healthy.container);
    const { course } = await publishedCourse(healthy.app, world.teacher.headers, world.institution.id);

    const ready = await degraded.app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(json(ready)).toMatchObject({ status: "degraded", checks: { database: { status: "up" }, redis: { status: "down" } } });

    const user = await createUser(degraded.container);
    const session = await login(degraded.app, user.email);
    const me = await degraded.app.inject({ method: "GET", url: "/v1/me", headers: bearer(session.accessToken) });
    expect(me.statusCode).toBe(200);

    const enroll = await degraded.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: { ...bearer(session.accessToken), "idempotency-key": "degraded-enrollment-1" } });
    expect(enroll.statusCode).toBe(201);
    await degraded.outbox.drain();
    const deliveries = await degraded.container.db.outboxEvent.count({ where: { aggregateId: { not: null }, processedAt: { not: null } } });
    expect(deliveries).toBeGreaterThan(0);

    const logout = await degraded.app.inject({ method: "POST", url: "/v1/auth/logout", headers: bearer(session.accessToken) });
    expect(logout.statusCode).toBe(200);
    const revoked = await degraded.app.inject({ method: "GET", url: "/v1/me", headers: bearer(session.accessToken) });
    expect(revoked.statusCode).toBe(401);
  });

  it("falls back to per-instance rate limiting", async () => {
    const user = await createUser(degraded.container);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await degraded.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: "Wrong-Password-000" } });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(5)).toContain(429);
    const legit = await degraded.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: DEFAULT_PASSWORD } });
    expect(legit.statusCode).toBe(429);
  });
});

function saturateEventLoop(milliseconds: number): void {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) Math.sqrt(Math.random());
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("database session", () => {
  it("pins the session to UTC so timestamps round-trip even when the server uses another time zone", async () => {
    const ctx = await createTestContext();
    try {
      await expect(assertDatabaseSessionTimeZone(ctx.container.db)).resolves.toBeUndefined();
      const written = new Date();
      const event = await ctx.container.db.outboxEvent.create({ data: { type: "timezone.probe", availableAt: written } });
      const stored = await ctx.container.db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(stored.availableAt.getTime()).toBe(written.getTime());
      const [row] = await ctx.container.db.$queryRaw<Array<{ due: boolean }>>`SELECT "availableAt" <= now() AS due FROM "outbox_events" WHERE "id" = ${event.id}::uuid`;
      expect(row?.due).toBe(true);
      await ctx.container.db.outboxEvent.delete({ where: { id: event.id } });
    } finally {
      await ctx.close();
    }
  });
});

describe("load shedding", () => {
  it("keeps serving after a single event loop stall on a freshly started instance", async () => {
    const ctx = await createTestContext();
    try {
      saturateEventLoop(2500);
      await pause(20);
      const user = await createUser(ctx.container);
      const response = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: user.password } });
      expect(response.statusCode).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  it("sheds API traffic only while the overload is sustained and keeps liveness available", async () => {
    const ctx = await createTestContext({ env: { LOAD_SHEDDING_SAMPLE_INTERVAL_MS: "50", LOAD_SHEDDING_SUSTAINED_SAMPLES: "3" } });
    try {
      await resetState(ctx.container);
      const deadline = performance.now() + 600;
      while (performance.now() < deadline) {
        saturateEventLoop(80);
        await new Promise((resolve) => setImmediate(resolve));
      }
      const shed = await ctx.app.inject({ method: "GET", url: "/v1/catalog/courses" });
      expect(shed.statusCode).toBe(503);
      expect(json(shed).error.code).toBe("SERVICE_UNAVAILABLE");
      expect(Number(shed.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      const live = await ctx.app.inject({ method: "GET", url: "/health/live" });
      expect(live.statusCode).toBe(200);
      await pause(300);
      const recovered = await ctx.app.inject({ method: "GET", url: "/v1/catalog/courses" });
      expect(recovered.statusCode).toBe(200);
    } finally {
      await ctx.close();
    }
  });
});

describe("BullMQ scheduler", () => {
  it("registers every maintenance job once and runs them through Redis", async () => {
    const ctx = await createTestContext({ env: { REDIS_KEY_PREFIX: `pe-sched-${Date.now()}:` } });
    try {
      await resetState(ctx.container);
      const handle = startScheduler(ctx.container, pino({ level: "silent" }));
      const inspector = new Queue(MAINTENANCE_QUEUE, { connection: createBlockingRedis({ url: testRedisUrl }, pino({ level: "silent" })), prefix: `${ctx.container.config.REDIS_KEY_PREFIX}bull` });
      let schedulers: Array<{ key: string }> = [];
      for (let attempt = 0; attempt < 50 && schedulers.length < scheduledJobs.length; attempt += 1) {
        schedulers = await inspector.getJobSchedulers();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(schedulers.map((item) => item.key).sort()).toEqual(scheduledJobs.map((job) => job.name).sort());
      const job = await inspector.add("tokens.cleanup", {});
      let state = await job.getState();
      for (let attempt = 0; attempt < 50 && state !== "completed" && state !== "failed"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = await job.getState();
      }
      expect(state).toBe("completed");
      await inspector.obliterate({ force: true });
      await inspector.close();
      await handle.close();
    } finally {
      await ctx.close();
    }
  });
});
