import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RoleScope } from "../../src/generated/prisma/enums.js";
import { erasedEmailFor } from "../../src/modules/privacy/privacy.service.js";
import { academicWorld, publishedCourse } from "../helpers/academic.js";
import { DEFAULT_PASSWORD, createUserWithSession, grantRole } from "../helpers/factories.js";
import { createTestContext, json, resetState, type TestContext } from "../helpers/test-app.js";

let ctx: TestContext;
let world: Awaited<ReturnType<typeof academicWorld>>;

beforeAll(async () => {
  ctx = await createTestContext({ container: { exportBatchSize: 3 } });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetState(ctx.container);
  ctx.mail.clear();
  world = await academicWorld(ctx.app, ctx.container);
});

const reauth = { password: DEFAULT_PASSWORD };

async function download(url: string) {
  const target = new URL(url);
  return ctx.app.inject({ method: "GET", url: `${target.pathname}${target.search}` });
}

async function completedCourseFor(headers: Record<string, string>) {
  const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id, { certificateEnabled: true }, [{ title: "Lectura", type: "ARTICLE", body: "Texto" }]);
  await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers });
  const outline = json(await ctx.app.inject({ method: "GET", url: `/v1/courses/${course.id}/outline`, headers })).data;
  await ctx.app.inject({ method: "POST", url: `/v1/lessons/${outline.modules[0].units[0].lessons[0].id}/complete`, headers });
  return course as { id: string };
}

describe("personal data export", () => {
  it("streams every personal data section to storage and only the owner can download it", async () => {
    await completedCourseFor(world.student.headers);
    for (let index = 0; index < 7; index += 1) {
      await ctx.container.db.notification.create({ data: { userId: world.student.user.id, category: "SYSTEM", type: "system.test", data: { params: { index } } } });
    }
    await ctx.container.db.notification.create({ data: { userId: world.secondStudent.user.id, category: "SYSTEM", type: "system.other", data: {} } });

    const denied = await ctx.app.inject({ method: "POST", url: "/v1/me/privacy/exports", headers: world.student.headers, payload: {} });
    expect(denied.statusCode).toBe(403);
    const requested = await ctx.app.inject({ method: "POST", url: "/v1/me/privacy/exports", headers: world.student.headers, payload: { reauth } });
    expect(requested.statusCode).toBe(202);
    const request = json(requested).data;
    expect(request.status).toBe("PENDING");
    const again = await ctx.app.inject({ method: "POST", url: "/v1/me/privacy/exports", headers: world.student.headers, payload: { reauth } });
    expect(json(again).data.id).toBe(request.id);

    await ctx.outbox.drain();
    const status = await ctx.app.inject({ method: "GET", url: `/v1/me/privacy/requests/${request.id}`, headers: world.student.headers });
    expect(status.statusCode).toBe(200);
    const completed = json(status).data;
    expect(completed.status).toBe("COMPLETED");
    expect(completed.downloadUrl).toBeTruthy();
    expect(new Date(completed.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const file = await download(completed.downloadUrl);
    expect(file.statusCode).toBe(200);
    const exported = JSON.parse(file.body);
    expect(exported.format).toBe("plataforma-educativa.personal-data");
    expect(exported.userId).toBe(world.student.user.id);
    expect(exported.sections.account.email).toBe(world.student.user.email);
    expect(exported.sections.notifications.filter((item: { type: string }) => item.type === "system.test")).toHaveLength(7);
    expect(exported.sections.enrollments).toHaveLength(1);
    expect(exported.sections.certificates).toHaveLength(1);
    expect(exported.sections.sessions.length).toBeGreaterThan(0);
    expect(file.body).not.toContain("passwordHash");
    expect(file.body).not.toContain("tokenHash");
    expect(file.body).not.toContain("secretCiphertext");
    expect(file.body).not.toContain(world.secondStudent.user.email);
    expect(file.body).not.toContain("system.other");

    const foreign = await ctx.app.inject({ method: "GET", url: `/v1/me/privacy/requests/${request.id}`, headers: world.secondStudent.headers });
    expect(foreign.statusCode).toBe(404);
    const listed = json(await ctx.app.inject({ method: "GET", url: "/v1/me/privacy/requests", headers: world.secondStudent.headers })).data;
    expect(listed).toHaveLength(0);

    const exportFile = await ctx.container.db.file.findFirstOrThrow({ where: { purpose: "DATA_EXPORT" } });
    expect(exportFile.ownerId).toBe(world.student.user.id);
    expect(exportFile.expiresAt).not.toBeNull();
    const directFile = await ctx.app.inject({ method: "GET", url: `/v1/files/${exportFile.id}`, headers: world.secondStudent.headers });
    expect(directFile.statusCode).toBe(404);

    await ctx.container.db.privacyRequest.update({ where: { id: request.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = json(await ctx.app.inject({ method: "GET", url: `/v1/me/privacy/requests/${request.id}`, headers: world.student.headers })).data;
    expect(expired.downloadUrl).toBeNull();

    const audit = await ctx.container.db.auditLog.findMany({ where: { action: { startsWith: "privacy.export" } } });
    expect(audit.map((entry) => entry.action)).toEqual(expect.arrayContaining(["privacy.export.requested", "privacy.export.completed", "privacy.export.download_issued"]));
    expect(audit.every((entry) => entry.legalHold)).toBe(true);
    const readyMail = ctx.mail.sent.find((mail) => mail.to === world.student.user.email && mail.subject.includes("exportación"));
    expect(readyMail).toBeDefined();
    expect(readyMail!.text).not.toContain("token=");
  });
});

describe("account deletion", () => {
  it("schedules deletion with a grace period and lets the user cancel it", async () => {
    const response = await ctx.app.inject({ method: "POST", url: "/v1/me/privacy/deletion", headers: world.student.headers, payload: { confirmation: "DELETE_MY_ACCOUNT", reauth } });
    expect(response.statusCode).toBe(202);
    const request = json(response).data;
    expect(request.type).toBe("DELETION");
    expect(new Date(request.scheduledFor).getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 3600 * 1000);
    expect(await ctx.container.privacy.executeDeletion(request.id)).toBeNull();

    const foreignCancel = await ctx.app.inject({ method: "POST", url: `/v1/me/privacy/requests/${request.id}/cancel`, headers: world.secondStudent.headers });
    expect(foreignCancel.statusCode).toBe(404);
    const cancel = await ctx.app.inject({ method: "POST", url: `/v1/me/privacy/requests/${request.id}/cancel`, headers: world.student.headers });
    expect(json(cancel).data.status).toBe("CANCELLED");
    expect(await ctx.container.privacy.executeDeletion(request.id, new Date(Date.now() + 30 * 24 * 3600 * 1000))).toBeNull();
    const me = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: world.student.headers });
    expect(me.statusCode).toBe(200);

    const missingConfirmation = await ctx.app.inject({ method: "POST", url: "/v1/me/privacy/deletion", headers: world.student.headers, payload: { reauth } });
    expect(missingConfirmation.statusCode).toBe(400);
  });

  it("anonymizes personal data, keeps legally required records and revokes access", async () => {
    const student = world.student;
    const course = await completedCourseFor(student.headers);
    const conversation = json(await ctx.app.inject({ method: "POST", url: "/v1/conversations/direct", headers: student.headers, payload: { userId: world.secondStudent.user.id } })).data;
    const sent = await ctx.app.inject({ method: "POST", url: `/v1/conversations/${conversation.id}/messages`, headers: student.headers, payload: { body: "Mi número personal es 555-0101" } });
    expect(sent.statusCode).toBe(201);
    await ctx.container.db.pushSubscription.create({ data: { userId: student.user.id, provider: "FCM", platform: "ANDROID", token: "fcm-token-for-deletion-test-000000000000" } });

    const scheduled = json(await ctx.app.inject({ method: "POST", url: "/v1/me/privacy/deletion", headers: student.headers, payload: { confirmation: "DELETE_MY_ACCOUNT", reauth } })).data;
    const summary = await ctx.container.privacy.executeDeletion(scheduled.id, new Date(Date.now() + 15 * 24 * 3600 * 1000));
    expect(summary).not.toBeNull();
    expect(summary!.messagesRedacted).toBe(1);
    expect(summary!.certificatesRevoked).toBe(1);
    expect(summary!.sessions).toBeGreaterThan(0);

    const user = await ctx.container.db.user.findUniqueOrThrow({ where: { id: student.user.id } });
    expect(user.email).toBe(erasedEmailFor(student.user.id));
    expect(user.displayName).toBe("[redacted]");
    expect(user.passwordHash).toBeNull();
    expect(user.status).toBe("DEACTIVATED");
    expect(user.anonymizedAt).not.toBeNull();
    expect(await ctx.container.db.userProfile.findUnique({ where: { userId: student.user.id } })).toBeNull();
    expect(await ctx.container.db.session.count({ where: { userId: student.user.id } })).toBe(0);
    expect(await ctx.container.db.pushSubscription.count({ where: { userId: student.user.id } })).toBe(0);
    expect(await ctx.container.db.notification.count({ where: { userId: student.user.id } })).toBe(0);
    expect(await ctx.container.db.activityEvent.count({ where: { userId: student.user.id } })).toBe(0);

    const message = await ctx.container.db.message.findFirstOrThrow({ where: { conversationId: conversation.id } });
    expect(message.body).toBe("");
    expect(message.senderId).toBeNull();
    expect(message.deletedAt).not.toBeNull();

    const enrollment = await ctx.container.db.enrollment.findFirstOrThrow({ where: { userId: student.user.id, courseId: course.id } });
    expect(enrollment.status).toBe("COMPLETED");
    const certificate = await ctx.container.db.certificate.findFirstOrThrow({ where: { userId: student.user.id } });
    expect(certificate.status).toBe("REVOKED");
    expect((certificate.snapshot as { learnerName: string }).learnerName).toBe("[redacted]");
    const verification = await ctx.app.inject({ method: "GET", url: `/v1/certificates/verify/${certificate.verificationCode}` });
    expect(verification.body).not.toContain(student.user.displayName);

    const auditTrail = await ctx.container.db.auditLog.count({ where: { actorId: student.user.id } });
    expect(auditTrail).toBeGreaterThan(0);
    const completedAudit = await ctx.container.db.auditLog.findFirstOrThrow({ where: { action: "privacy.deletion.completed" } });
    expect(completedAudit.legalHold).toBe(true);

    const oldToken = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: student.headers });
    expect(oldToken.statusCode).toBe(401);
    const login = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: student.user.email, password: DEFAULT_PASSWORD } });
    expect(login.statusCode).toBe(401);
    const reused = await ctx.app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: student.user.email, password: "Another-Strong-Pass-99", displayName: "Nuevo", acceptTerms: true } });
    expect(reused.statusCode).toBe(202);
    const request = await ctx.container.db.privacyRequest.findUniqueOrThrow({ where: { id: scheduled.id } });
    expect(request.status).toBe("COMPLETED");
    expect(await ctx.container.privacy.executeDeletion(scheduled.id, new Date(Date.now() + 20 * 24 * 3600 * 1000))).toBeNull();
  });

  it("requires platform administrators to hand over their role and restricts the admin listing", async () => {
    const root = await createUserWithSession(ctx.app, ctx.container, { displayName: "Root" });
    await grantRole(ctx.container, root.user.id, "platform_admin", { type: RoleScope.PLATFORM });
    const blocked = await ctx.app.inject({ method: "POST", url: "/v1/me/privacy/deletion", headers: root.headers, payload: { confirmation: "DELETE_MY_ACCOUNT", reauth } });
    expect(blocked.statusCode).toBe(409);
    await ctx.app.inject({ method: "POST", url: "/v1/me/privacy/deletion", headers: world.student.headers, payload: { confirmation: "DELETE_MY_ACCOUNT", reauth } });
    const forbidden = await ctx.app.inject({ method: "GET", url: "/v1/admin/privacy-requests", headers: world.admin.headers });
    expect(forbidden.statusCode).toBe(403);
    const listing = json(await ctx.app.inject({ method: "GET", url: "/v1/admin/privacy-requests?type=DELETION", headers: root.headers }));
    expect(listing.meta.total).toBe(1);
    expect(listing.data[0].userId).toBe(world.student.user.id);
  });

  it("processes due deletions from the durable outbox", async () => {
    const scheduled = json(await ctx.app.inject({ method: "POST", url: "/v1/me/privacy/deletion", headers: world.secondStudent.headers, payload: { confirmation: "DELETE_MY_ACCOUNT", reauth } })).data;
    await ctx.container.db.privacyRequest.update({ where: { id: scheduled.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    await ctx.container.db.outboxEvent.updateMany({ where: { type: "privacy.deletion" }, data: { availableAt: new Date(Date.now() - 1000) } });
    await ctx.outbox.drain();
    const request = await ctx.container.db.privacyRequest.findUniqueOrThrow({ where: { id: scheduled.id } });
    expect(request.status).toBe("COMPLETED");
    const user = await ctx.container.db.user.findUniqueOrThrow({ where: { id: world.secondStudent.user.id } });
    expect(user.anonymizedAt).not.toBeNull();
  });
});
