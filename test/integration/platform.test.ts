import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RoleScope } from "../../src/generated/prisma/enums.js";
import { attachRealtime } from "../../src/modules/realtime/realtime.gateway.js";
import { academicWorld, publishedCourse } from "../helpers/academic.js";
import { bearer, createUserWithSession, grantRole } from "../helpers/factories.js";
import { createTestContext, json, resetState, type TestContext } from "../helpers/test-app.js";

let ctx: TestContext;
let world: Awaited<ReturnType<typeof academicWorld>>;
const webhookSecret = `whsec_${randomBytes(24).toString("base64")}`;

beforeAll(async () => {
  ctx = await createTestContext({ env: { RESEND_WEBHOOK_SECRET: webhookSecret } });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetState(ctx.container);
  ctx.mail.clear();
  world = await academicWorld(ctx.app, ctx.container);
});

const pngBytes = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d5b1a40000000049454e44ae426082",
  "hex",
);

async function uploadAvatar(headers: Record<string, string>, content: Buffer, mimeType = "image/png") {
  const intent = await ctx.app.inject({
    method: "POST",
    url: "/v1/files/uploads",
    headers,
    payload: { purpose: "AVATAR", fileName: "../../etc/avatar.png", mimeType, sizeBytes: content.length },
  });
  expect(intent.statusCode).toBe(201);
  const { file, upload } = json(intent).data;
  const target = new URL(upload.url);
  const put = await ctx.app.inject({ method: "PUT", url: `${target.pathname}${target.search}`, headers: { "content-type": mimeType }, payload: content });
  expect(put.statusCode).toBe(204);
  return { fileId: file.id as string, originalName: file.originalName as string, complete: () => ctx.app.inject({ method: "POST", url: `/v1/files/${file.id}/complete`, headers }) };
}

describe("files", () => {
  it("accepts a real image, sanitizes the name and serves it through a signed URL", async () => {
    const { fileId, originalName, complete } = await uploadAvatar(world.student.headers, pngBytes);
    expect(originalName).toBe("avatar.png");
    const completed = await complete();
    expect(completed.statusCode).toBe(200);
    expect(json(completed).data.status).toBe("READY");
    const profile = await ctx.app.inject({ method: "PATCH", url: "/v1/me/profile", headers: world.student.headers, payload: { avatarFileId: fileId } });
    expect(profile.statusCode).toBe(200);
    const described = json(await ctx.app.inject({ method: "GET", url: `/v1/files/${fileId}`, headers: world.teacher.headers })).data;
    const downloadUrl = new URL(described.downloadUrl);
    const download = await ctx.app.inject({ method: "GET", url: `${downloadUrl.pathname}${downloadUrl.search}` });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    const tampered = await ctx.app.inject({ method: "GET", url: `${downloadUrl.pathname}${downloadUrl.search}x` });
    expect(tampered.statusCode).toBe(404);
  });

  it("rejects files whose content does not match the declared type", async () => {
    const { complete } = await uploadAvatar(world.student.headers, Buffer.from("<svg onload=alert(1)></svg>".padEnd(80, " ")));
    const response = await complete();
    expect(response.statusCode).toBe(400);
    expect(json(response).error.code).toBe("FILE_REJECTED");
  });

  it("refuses dangerous types and oversized uploads before issuing URLs", async () => {
    const svg = await ctx.app.inject({ method: "POST", url: "/v1/files/uploads", headers: world.student.headers, payload: { purpose: "AVATAR", fileName: "a.svg", mimeType: "image/svg+xml", sizeBytes: 100 } });
    expect(svg.statusCode).toBe(400);
    const huge = await ctx.app.inject({ method: "POST", url: "/v1/files/uploads", headers: world.student.headers, payload: { purpose: "AVATAR", fileName: "a.png", mimeType: "image/png", sizeBytes: 50 * 1024 * 1024 } });
    expect(huge.statusCode).toBe(400);
    const courseFile = await ctx.app.inject({
      method: "POST",
      url: "/v1/files/uploads",
      headers: world.student.headers,
      payload: { purpose: "LESSON_RESOURCE", fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 100, courseId: "00000000-0000-7000-8000-000000000000" },
    });
    expect(courseFile.statusCode).toBe(404);
  });
});

describe("messaging and realtime", () => {
  it("delivers direct messages in real time and disconnects revoked sessions", async () => {
    const address = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const gateway = attachRealtime(ctx.app.server, ctx.container);
    const port = (ctx.app.server.address() as AddressInfo).port;
    const sockets: Socket[] = [];
    try {
      const open = await ctx.app.inject({ method: "POST", url: "/v1/conversations/direct", headers: world.student.headers, payload: { userId: world.teacher.user.id } });
      expect(open.statusCode).toBe(200);
      const conversationId = json(open).data.id as string;

      const unauthorized = connect(`http://127.0.0.1:${port}`, { path: "/realtime", transports: ["websocket"], auth: { token: "invalid" }, reconnection: false });
      sockets.push(unauthorized);
      const rejection = await new Promise<string>((resolve) => unauthorized.on("connect_error", (error) => resolve(error.message)));
      expect(rejection).toBe("TOKEN_INVALID");

      const teacherSocket = connect(`http://127.0.0.1:${port}`, { path: "/realtime", transports: ["websocket"], auth: { token: world.teacher.accessToken }, reconnection: false });
      sockets.push(teacherSocket);
      await new Promise<void>((resolve, reject) => {
        teacherSocket.on("connect", () => resolve());
        teacherSocket.on("connect_error", reject);
      });
      const joined = await teacherSocket.emitWithAck("conversation:join", { conversationId });
      expect(joined.ok).toBe(true);
      const outsiderJoin = await teacherSocket.emitWithAck("conversation:join", { conversationId: "00000000-0000-7000-8000-000000000000" });
      expect(outsiderJoin.ok).toBe(false);

      const received = new Promise<{ body: string }>((resolve) => teacherSocket.on("message:new", resolve));
      const send = await ctx.app.inject({
        method: "POST",
        url: `/v1/conversations/${conversationId}/messages`,
        headers: world.student.headers,
        payload: { body: "Hola profesora, tengo una duda", clientMessageId: "client-msg-00000001" },
      });
      expect(send.statusCode).toBe(201);
      expect((await received).body).toBe("Hola profesora, tengo una duda");

      const retry = await ctx.app.inject({
        method: "POST",
        url: `/v1/conversations/${conversationId}/messages`,
        headers: world.student.headers,
        payload: { body: "Hola profesora, tengo una duda", clientMessageId: "client-msg-00000001" },
      });
      expect(json(retry).data.id).toBe(json(send).data.id);

      const list = json(await ctx.app.inject({ method: "GET", url: "/v1/conversations", headers: world.teacher.headers })).data;
      expect(list[0].unreadCount).toBe(1);

      const revoked = new Promise<string>((resolve) => teacherSocket.on("auth:revoked", (payload: { reason: string }) => resolve(payload.reason)));
      const disconnected = new Promise<void>((resolve) => teacherSocket.on("disconnect", () => resolve()));
      await ctx.app.inject({ method: "POST", url: "/v1/auth/logout", headers: world.teacher.headers });
      expect(await revoked).toContain("session_revoked");
      await disconnected;
    } finally {
      sockets.forEach((socket) => socket.close());
      await gateway.close();
      expect(address).toContain("127.0.0.1");
    }
  });

  it("keeps clients of other instances connected when one instance shuts down", async () => {
    const listen = async () => {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server;
    };
    const portOf = (server: HttpServer) => (server.address() as AddressInfo).port;
    const leaving = await listen();
    const remaining = await listen();
    const leavingGateway = attachRealtime(leaving, ctx.container);
    const remainingGateway = attachRealtime(remaining, ctx.container);
    const open = (port: number) => {
      const socket = connect(`http://127.0.0.1:${port}`, { path: "/realtime", transports: ["websocket"], auth: { token: world.student.accessToken }, reconnection: false });
      return new Promise<Socket>((resolve, reject) => {
        socket.on("connect", () => resolve(socket));
        socket.on("connect_error", reject);
      });
    };
    const leavingSocket = await open(portOf(leaving));
    const remainingSocket = await open(portOf(remaining));
    try {
      await leavingGateway.close();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(leavingSocket.connected).toBe(false);
      expect(remainingSocket.connected).toBe(true);
    } finally {
      leavingSocket.close();
      remainingSocket.close();
      await remainingGateway.close();
    }
  });

  it("enforces messaging privacy and institution boundaries", async () => {
    const outsider = await ctx.app.inject({ method: "POST", url: "/v1/conversations/direct", headers: world.outsider.headers, payload: { userId: world.student.user.id } });
    expect(outsider.statusCode).toBe(403);
    await ctx.app.inject({ method: "PATCH", url: "/v1/me/preferences", headers: world.secondStudent.headers, payload: { privacy: { allowDirectMessages: "nobody" } } });
    const blocked = await ctx.app.inject({ method: "POST", url: "/v1/conversations/direct", headers: world.student.headers, payload: { userId: world.secondStudent.user.id } });
    expect(blocked.statusCode).toBe(403);
    const peek = await ctx.app.inject({ method: "POST", url: "/v1/conversations/direct", headers: world.student.headers, payload: { userId: world.teacher.user.id } });
    const conversationId = json(peek).data.id;
    const foreignRead = await ctx.app.inject({ method: "GET", url: `/v1/conversations/${conversationId}/messages`, headers: world.secondStudent.headers });
    expect(foreignRead.statusCode).toBe(404);
  });

  it("fans out course announcements to enrolled learners", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers });
    await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.secondStudent.headers });
    const studentAttempt = await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/announcements`, headers: world.student.headers, payload: { title: "Hack", body: "No" } });
    expect(studentAttempt.statusCode).toBe(404);
    const created = await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/announcements`, headers: world.teacher.headers, payload: { title: "Examen el lunes", body: "Repasen el módulo 1" } });
    expect(created.statusCode).toBe(201);
    await ctx.outbox.drain();
    const notified = await ctx.container.db.notification.count({ where: { type: "announcement.published" } });
    expect(notified).toBe(2);
    await ctx.outbox.drain();
    expect(await ctx.container.db.notification.count({ where: { type: "announcement.published" } })).toBe(2);
  });
});

describe("administration, reports and webhooks", () => {
  it("restricts admin endpoints and lets platform admins suspend users", async () => {
    const denied = await ctx.app.inject({ method: "GET", url: "/v1/admin/users", headers: world.admin.headers });
    expect(denied.statusCode).toBe(403);
    const root = await createUserWithSession(ctx.app, ctx.container, { displayName: "Root" });
    await grantRole(ctx.container, root.user.id, "platform_admin", { type: RoleScope.PLATFORM });
    const users = await ctx.app.inject({ method: "GET", url: "/v1/admin/users?search=estudiante", headers: root.headers });
    expect(json(users).meta.total).toBe(2);
    const suspend = await ctx.app.inject({ method: "POST", url: `/v1/admin/users/${world.student.user.id}/status`, headers: root.headers, payload: { status: "SUSPENDED", reason: "Investigación de fraude" } });
    expect(suspend.statusCode).toBe(200);
    const studentRequest = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: world.student.headers });
    expect(studentRequest.statusCode).toBe(401);
    const audit = json(await ctx.app.inject({ method: "GET", url: "/v1/admin/audit-logs?action=admin.user", headers: root.headers })).data;
    expect(audit[0].action).toBe("admin.user.suspended");
    const escalation = await ctx.app.inject({ method: "POST", url: "/v1/admin/role-assignments", headers: world.admin.headers, payload: { userId: world.admin.user.id, roleKey: "platform_admin" } });
    expect(escalation.statusCode).toBe(403);
  });

  it("exports CSV reports safely for the requester only", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    await ctx.container.db.user.update({ where: { id: world.student.user.id }, data: { displayName: "=HYPERLINK(\"http://evil\")" } });
    await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers });
    const requested = await ctx.app.inject({ method: "POST", url: "/v1/reports/exports", headers: world.teacher.headers, payload: { type: "course.enrollments", courseId: course.id } });
    expect(requested.statusCode).toBe(202);
    const exportId = json(requested).data.id;
    await ctx.outbox.drain();
    const status = json(await ctx.app.inject({ method: "GET", url: `/v1/reports/exports/${exportId}`, headers: world.teacher.headers })).data;
    expect(status.status).toBe("COMPLETED");
    const csvUrl = new URL(status.downloadUrl);
    const csv = await ctx.app.inject({ method: "GET", url: `${csvUrl.pathname}${csvUrl.search}` });
    expect(csv.body).toContain("'=HYPERLINK");
    const foreign = await ctx.app.inject({ method: "GET", url: `/v1/reports/exports/${exportId}`, headers: world.admin.headers });
    expect(foreign.statusCode).toBe(404);
    const denied = await ctx.app.inject({ method: "POST", url: "/v1/reports/exports", headers: world.student.headers, payload: { type: "course.enrollments", courseId: course.id } });
    expect(denied.statusCode).toBe(404);
  });

  it("verifies webhook signatures, rejects replays and deduplicates deliveries", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { to: ["bounce@example.com"] } });
    const sign = (id: string, timestamp: number) => {
      const key = Buffer.from(webhookSecret.slice(6), "base64");
      const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
      return { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${signature}`, "content-type": "application/json" };
    };
    const now = Math.floor(Date.now() / 1000);
    const valid = await ctx.app.inject({ method: "POST", url: "/v1/webhooks/email/resend", headers: sign("msg_1", now), payload: body });
    expect(valid.statusCode).toBe(202);
    const duplicate = await ctx.app.inject({ method: "POST", url: "/v1/webhooks/email/resend", headers: sign("msg_1", now), payload: body });
    expect(json(duplicate).data.duplicate).toBe(true);
    const stale = await ctx.app.inject({ method: "POST", url: "/v1/webhooks/email/resend", headers: sign("msg_2", now - 3600), payload: body });
    expect(stale.statusCode).toBe(401);
    const forged = await ctx.app.inject({ method: "POST", url: "/v1/webhooks/email/resend", headers: { ...sign("msg_3", now), "svix-signature": "v1,AAAA" }, payload: body });
    expect(forged.statusCode).toBe(401);
    await ctx.outbox.drain();
    expect(await ctx.container.db.emailSuppression.findUnique({ where: { email: "bounce@example.com" } })).not.toBeNull();
  });
});

describe("observability and documentation", () => {
  it("reports readiness, protects metrics and publishes OpenAPI", async () => {
    const ready = await ctx.app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(json(ready).checks.database.status).toBe("up");
    const metricsDenied = await ctx.app.inject({ method: "GET", url: "/metrics" });
    expect(metricsDenied.statusCode).toBe(401);
    const metrics = await ctx.app.inject({ method: "GET", url: "/metrics", headers: bearer("test-metrics-token-0123456789abcdef") });
    expect(metrics.body).toContain("http_request_duration_seconds");
    const spec = await ctx.app.inject({ method: "GET", url: "/docs/json" });
    expect(spec.statusCode).toBe(200);
    const paths = Object.keys(json(spec).paths);
    expect(paths.length).toBeGreaterThan(100);
    expect(paths).toContain("/v1/auth/login");
  });
});
