import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScannerUnavailableError, type MalwareScanner, type ScanVerdict } from "../../src/core/antivirus/malware-scanner.js";
import { RoleScope } from "../../src/generated/prisma/enums.js";
import { attachRealtime } from "../../src/modules/realtime/realtime.gateway.js";
import { academicWorld, publishedCourse } from "../helpers/academic.js";
import { DEFAULT_PASSWORD, createUser, createUserWithSession, grantRole, uniqueEmail } from "../helpers/factories.js";
import { createTestContext, json, resetState, type TestContext } from "../helpers/test-app.js";

class RecordingScanner implements MalwareScanner {
  readonly name = "recording-scanner";
  readonly enabled = true;
  scanned: Buffer[] = [];

  async scan(stream: Readable): Promise<ScanVerdict> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const content = Buffer.concat(chunks);
    this.scanned.push(content);
    if (content.includes(Buffer.from("EICAR"))) return { status: "infected", signature: "Eicar-Test-Signature" };
    return { status: "clean" };
  }

  ping(): Promise<boolean> {
    return Promise.reject(new ScannerUnavailableError("not used"));
  }
}

const pngBytes = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d5b1a40000000049454e44ae426082",
  "hex",
);

function mp4Bytes(size: number): Buffer {
  const header = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");
  return Buffer.concat([header, Buffer.alloc(size - header.length, 0x20)]);
}

const scanner = new RecordingScanner();
let ctx: TestContext;
let world: Awaited<ReturnType<typeof academicWorld>>;

beforeAll(async () => {
  ctx = await createTestContext({ env: { ANTIVIRUS_PROVIDER: "clamav", FILE_SCAN_REQUIRED: "true" }, infra: { scanner } });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetState(ctx.container);
  ctx.mail.clear();
  scanner.scanned = [];
  world = await academicWorld(ctx.app, ctx.container);
});

async function requestUpload(target: TestContext, headers: Record<string, string>, payload: Record<string, unknown>) {
  const intent = await target.app.inject({ method: "POST", url: "/v1/files/uploads", headers, payload });
  expect(intent.statusCode).toBe(201);
  const body = json(intent).data;
  const url = new URL(body.upload.url);
  return { fileId: body.file.id as string, uploadPath: `${url.pathname}${url.search}` };
}

async function download(target: TestContext, headers: Record<string, string>, fileId: string) {
  const described = json(await target.app.inject({ method: "GET", url: `/v1/files/${fileId}`, headers })).data;
  expect(described.downloadUrl).toBeTruthy();
  const url = new URL(described.downloadUrl);
  return target.app.inject({ method: "GET", url: `${url.pathname}${url.search}` });
}

describe("upload staging", () => {
  it("ignores content written with a still valid upload URL after the file was accepted", async () => {
    const { fileId, uploadPath } = await requestUpload(ctx, world.student.headers, { purpose: "AVATAR", fileName: "avatar.png", mimeType: "image/png", sizeBytes: pngBytes.length });
    expect((await ctx.app.inject({ method: "PUT", url: uploadPath, headers: { "content-type": "image/png" }, payload: pngBytes })).statusCode).toBe(204);
    const completed = await ctx.app.inject({ method: "POST", url: `/v1/files/${fileId}/complete`, headers: world.student.headers });
    expect(json(completed).data.status).toBe("PROCESSING");

    const swapped = Buffer.from(pngBytes);
    swapped.write("EICAR", pngBytes.length - 5);
    expect((await ctx.app.inject({ method: "PUT", url: uploadPath, headers: { "content-type": "image/png" }, payload: swapped })).statusCode).toBe(204);
    const again = await ctx.app.inject({ method: "POST", url: `/v1/files/${fileId}/complete`, headers: world.student.headers });
    expect(again.statusCode).toBe(409);

    await ctx.outbox.drain();
    expect(scanner.scanned).toHaveLength(1);
    expect(scanner.scanned[0]!.equals(pngBytes)).toBe(true);
    const served = await download(ctx, world.student.headers, fileId);
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.equals(pngBytes)).toBe(true);
    expect(await ctx.container.db.outboxEvent.count({ where: { type: "file.scan", aggregateId: fileId } })).toBe(1);
  });

  it("rejects media that cannot be scanned when scanning is mandatory", async () => {
    const strict = await createTestContext({ env: { ANTIVIRUS_PROVIDER: "clamav", FILE_SCAN_REQUIRED: "true", ANTIVIRUS_MAX_SCAN_BYTES: "1024" }, infra: { scanner } });
    try {
      const { course } = await publishedCourse(strict.app, world.teacher.headers, world.institution.id);
      const video = mp4Bytes(4096);
      const { fileId, uploadPath } = await requestUpload(strict, world.teacher.headers, { purpose: "LESSON_MEDIA", fileName: "clase.mp4", mimeType: "video/mp4", sizeBytes: video.length, courseId: course.id });
      expect((await strict.app.inject({ method: "PUT", url: uploadPath, headers: { "content-type": "video/mp4" }, payload: video })).statusCode).toBe(204);
      const completed = await strict.app.inject({ method: "POST", url: `/v1/files/${fileId}/complete`, headers: world.teacher.headers });
      expect(completed.statusCode).toBe(400);
      expect(json(completed).error.details.reason).toBe("SCAN_SIZE_LIMIT");
      const stored = await strict.container.db.file.findUniqueOrThrow({ where: { id: fileId } });
      expect(stored.status).toBe("REJECTED");
    } finally {
      await strict.close();
    }
  });
});

describe("cache invalidation", () => {
  it("never serves a session snapshot cached before the session was revoked", async () => {
    const { sessionId, headers } = world.student;
    expect((await ctx.app.inject({ method: "GET", url: "/v1/me", headers })).statusCode).toBe(200);
    const stale = await ctx.container.sessionStore.load(sessionId);
    expect(stale?.revoked).toBe(false);
    await ctx.container.sessions.revoke(sessionId, "LOGOUT");
    await ctx.container.redis.set(ctx.container.keys.key("session", `{${sessionId}}`), JSON.stringify({ version: "0", snapshot: stale }), "EX", 60);
    const afterRace = await ctx.container.sessionStore.load(sessionId);
    expect(afterRace?.revoked).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: "/v1/me", headers })).statusCode).toBe(401);
  });

  it("drops cached permissions of every member when an institution is suspended", async () => {
    const root = await createUserWithSession(ctx.app, ctx.container, { displayName: "Root" });
    await grantRole(ctx.container, root.user.id, "platform_admin", { type: RoleScope.PLATFORM });
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const before = await ctx.app.inject({ method: "GET", url: `/v1/institutions/${world.institution.id}/courses`, headers: world.teacher.headers });
    expect(json(before).data.map((item: { id: string }) => item.id)).toEqual([course.id]);
    const suspended = await ctx.app.inject({ method: "PATCH", url: `/v1/institutions/${world.institution.id}`, headers: root.headers, payload: { status: "SUSPENDED" } });
    expect(suspended.statusCode).toBe(200);
    const after = await ctx.app.inject({ method: "GET", url: `/v1/institutions/${world.institution.id}/courses`, headers: world.teacher.headers });
    expect(after.statusCode === 404 || json(after).data.length === 0).toBe(true);
    const edit = await ctx.app.inject({ method: "PATCH", url: `/v1/courses/${course.id}`, headers: { ...world.teacher.headers, "if-match": `"${course.version}"` }, payload: { title: "Cambio no autorizado" } });
    expect(edit.statusCode).toBe(404);
  });
});

describe("browser sessions", () => {
  it("lets a reloaded web client recover its CSRF token only from an allowed origin", async () => {
    const user = await createUser(ctx.container);
    const login = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: DEFAULT_PASSWORD, tokenDelivery: "cookie" } });
    const refreshCookie = login.cookies.find((cookie) => cookie.name === "pe_rt")!;
    const csrfCookie = login.cookies.find((cookie) => cookie.name === "pe_csrf")!;
    expect((await ctx.app.inject({ method: "GET", url: "/v1/auth/csrf" })).statusCode).toBe(401);
    const foreign = await ctx.app.inject({ method: "GET", url: "/v1/auth/csrf", headers: { cookie: `pe_rt=${refreshCookie.value}`, origin: "https://evil.example" } });
    expect(foreign.statusCode).toBe(403);
    const recovered = await ctx.app.inject({ method: "GET", url: "/v1/auth/csrf", headers: { cookie: `pe_rt=${refreshCookie.value}; pe_csrf=${csrfCookie.value}`, origin: "http://app.test.local" } });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.headers["cache-control"]).toBe("no-store");
    const csrfToken = json(recovered).data.csrfToken as string;
    expect(csrfToken).toBe(csrfCookie.value);
    const refreshed = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { cookie: `pe_rt=${refreshCookie.value}; pe_csrf=${csrfCookie.value}`, "x-csrf-token": csrfToken } });
    expect(refreshed.statusCode).toBe(200);
  });

  it("limits how often a pending registration can be overwritten", async () => {
    const email = uniqueEmail("pending");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: { email, password: `Correct-Horse-Battery-${attempt}${attempt}`, displayName: "Persona Pendiente", acceptTerms: true },
      });
      expect(response.statusCode).toBe(202);
    }
    await ctx.outbox.drain();
    expect(ctx.mail.sent.filter((message) => message.to === email)).toHaveLength(4);
    expect(await ctx.container.db.outboxEvent.count({ where: { processedAt: { not: null }, sensitivePayload: { not: null } } })).toBe(0);
  });
});

describe("conversation access", () => {
  it("removes former learners from course conversations over HTTP and realtime", async () => {
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const gateway = attachRealtime(ctx.app.server, ctx.container, { revalidateIntervalMs: 100 });
    const port = (ctx.app.server.address() as AddressInfo).port;
    let socket: Socket | null = null;
    try {
      const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
      const enrollment = json(await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers })).data;
      const conversationId = json(await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/conversation`, headers: world.teacher.headers })).data.id as string;
      expect((await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/conversation`, headers: world.student.headers })).statusCode).toBe(200);

      socket = connect(`http://127.0.0.1:${port}`, { path: "/realtime", transports: ["websocket"], auth: { token: world.student.accessToken }, reconnection: false });
      await new Promise<void>((resolve, reject) => {
        socket!.on("connect", () => resolve());
        socket!.on("connect_error", reject);
      });
      expect((await socket.emitWithAck("conversation:join", { conversationId })).ok).toBe(true);
      const received: string[] = [];
      socket.on("message:new", (message: { body: string }) => received.push(message.body));

      await ctx.app.inject({ method: "POST", url: `/v1/conversations/${conversationId}/messages`, headers: world.teacher.headers, payload: { body: "Bienvenidos" } });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(received).toEqual(["Bienvenidos"]);

      const cancelled = await ctx.app.inject({ method: "POST", url: `/v1/enrollments/${enrollment.id}/cancel`, headers: world.student.headers, payload: {} });
      expect(cancelled.statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await ctx.app.inject({ method: "POST", url: `/v1/conversations/${conversationId}/messages`, headers: world.teacher.headers, payload: { body: "Solo para inscritos" } });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(received).toEqual(["Bienvenidos"]);
      expect((await ctx.app.inject({ method: "GET", url: `/v1/conversations/${conversationId}/messages`, headers: world.student.headers })).statusCode).toBe(404);
      expect((await socket.emitWithAck("conversation:join", { conversationId })).ok).toBe(false);
    } finally {
      socket?.close();
      await gateway.close();
    }
  });

  it("does not let learners pull members who refuse messages into group chats", async () => {
    await ctx.app.inject({ method: "PATCH", url: "/v1/me/preferences", headers: world.secondStudent.headers, payload: { privacy: { allowDirectMessages: "nobody" } } });
    const blocked = await ctx.app.inject({
      method: "POST",
      url: "/v1/conversations/groups",
      headers: world.student.headers,
      payload: { institutionId: world.institution.id, title: "Equipo", participantIds: [world.secondStudent.user.id] },
    });
    expect(blocked.statusCode).toBe(403);
    const staff = await ctx.app.inject({
      method: "POST",
      url: "/v1/conversations/groups",
      headers: world.admin.headers,
      payload: { institutionId: world.institution.id, title: "Tutoría", participantIds: [world.secondStudent.user.id, world.student.user.id] },
    });
    expect(staff.statusCode).toBeLessThan(300);
    const conversations = json(await ctx.app.inject({ method: "GET", url: "/v1/conversations", headers: world.student.headers })).data;
    expect(conversations).toHaveLength(1);
    expect(conversations[0].participants).toHaveLength(3);
    expect(conversations[0].lastMessage).toBeNull();
    const badCursor = await ctx.app.inject({ method: "GET", url: `/v1/conversations?cursor=${Buffer.from(JSON.stringify({ id: "00000000-0000-7000-8000-000000000000", sort: "not-a-date" })).toString("base64url")}`, headers: world.student.headers });
    expect(badCursor.statusCode).toBe(400);
  });
});

describe("background work idempotency", () => {
  it("generates a report export once even when the event is delivered twice", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers });
    const requested = await ctx.app.inject({ method: "POST", url: "/v1/reports/exports", headers: world.teacher.headers, payload: { type: "course.enrollments", courseId: course.id } });
    const exportId = json(requested).data.id as string;
    await Promise.all([ctx.container.reports.generate(exportId), ctx.container.reports.generate(exportId)]);
    const row = await ctx.container.db.reportExport.findUniqueOrThrow({ where: { id: exportId } });
    expect(row.status).toBe("COMPLETED");
    expect(await ctx.container.db.file.count({ where: { purpose: "REPORT_EXPORT" } })).toBe(1);
    await ctx.container.reports.generate(exportId);
    expect(await ctx.container.db.file.count({ where: { purpose: "REPORT_EXPORT" } })).toBe(1);
  });

  it("resumes a re-encryption run whose background event was lost", async () => {
    const run = await ctx.container.db.keyRotationRun.create({ data: { targetKeyId: ctx.container.encryptor.activeKey } });
    await ctx.container.db.$executeRaw`UPDATE "key_rotation_runs" SET "updatedAt" = now() - interval '2 hours' WHERE "id" = ${run.id}::uuid`;
    const resumed = await ctx.container.keyRotation.start(null, null);
    expect(resumed?.id).toBe(run.id);
    expect(await ctx.container.db.outboxEvent.count({ where: { type: "security.encryption.reencrypt", aggregateId: run.id, processedAt: null } })).toBe(1);
    await ctx.container.keyRotation.start(null, null);
    expect(await ctx.container.db.outboxEvent.count({ where: { type: "security.encryption.reencrypt", aggregateId: run.id } })).toBe(1);
    await ctx.outbox.drain();
    expect((await ctx.container.db.keyRotationRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("COMPLETED");
  });
});
