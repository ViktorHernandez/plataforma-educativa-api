import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScannerUnavailableError, type MalwareScanner, type ScanVerdict } from "../../src/core/antivirus/malware-scanner.js";
import { integrationTokenAad, mfaSecretAad } from "../../src/core/crypto/encrypted-columns.js";
import { FieldEncryptor } from "../../src/core/crypto/field-encryption.js";
import { LocalStorageProvider } from "../../src/core/storage/local-storage.js";
import { RoleScope } from "../../src/generated/prisma/enums.js";
import { academicWorld, publishedCourse } from "../helpers/academic.js";
import { createUser, createUserWithSession, grantRole } from "../helpers/factories.js";
import { createTestContext, json, resetState, type TestContext } from "../helpers/test-app.js";
import { testEnv } from "../helpers/test-env.js";

class FakeScanner implements MalwareScanner {
  readonly name = "fake-clamav";
  readonly enabled = true;
  mode: "clean" | "infected" | "down" = "clean";
  scanned: number[] = [];

  async scan(stream: Readable): Promise<ScanVerdict> {
    let size = 0;
    for await (const chunk of stream) size += (chunk as Buffer).length;
    this.scanned.push(size);
    if (this.mode === "down") throw new ScannerUnavailableError("clamd unreachable");
    return this.mode === "infected" ? { status: "infected", signature: "Eicar-Test-Signature" } : { status: "clean" };
  }

  ping(): Promise<boolean> {
    return Promise.resolve(this.mode !== "down");
  }
}

const scanner = new FakeScanner();
let ctx: TestContext;
let world: Awaited<ReturnType<typeof academicWorld>>;

beforeAll(async () => {
  ctx = await createTestContext({ env: { ANTIVIRUS_PROVIDER: "clamav", FILE_SCAN_REQUIRED: "true", KEY_ROTATION_BATCH_SIZE: "10" }, infra: { scanner }, container: { exportBatchSize: 3 } });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetState(ctx.container);
  scanner.mode = "clean";
  scanner.scanned = [];
  world = await academicWorld(ctx.app, ctx.container);
});

const pngBytes = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d5b1a40000000049454e44ae426082",
  "hex",
);

async function uploadAvatar(headers: Record<string, string>) {
  const intent = json(await ctx.app.inject({ method: "POST", url: "/v1/files/uploads", headers, payload: { purpose: "AVATAR", fileName: "avatar.png", mimeType: "image/png", sizeBytes: pngBytes.length } })).data;
  const target = new URL(intent.upload.url);
  await ctx.app.inject({ method: "PUT", url: `${target.pathname}${target.search}`, headers: { "content-type": "image/png" }, payload: pngBytes });
  const completed = await ctx.app.inject({ method: "POST", url: `/v1/files/${intent.file.id}/complete`, headers });
  expect(completed.statusCode).toBe(200);
  return json(completed).data as { id: string; status: string; scanStatus: string };
}

function localPath(key: string): string {
  return path.resolve(testEnv["STORAGE_LOCAL_DIR"]!, key);
}

describe("antivirus scanning", () => {
  it("keeps new uploads unavailable until the worker reports them clean", async () => {
    const file = await uploadAvatar(world.student.headers);
    expect(file.status).toBe("PROCESSING");
    expect(file.scanStatus).toBe("PENDING");
    const pending = json(await ctx.app.inject({ method: "GET", url: `/v1/files/${file.id}`, headers: world.student.headers })).data;
    expect(pending.downloadUrl).toBeNull();
    const avatar = await ctx.app.inject({ method: "PATCH", url: "/v1/me/profile", headers: world.student.headers, payload: { avatarFileId: file.id } });
    expect(avatar.statusCode).toBeGreaterThanOrEqual(400);

    await ctx.outbox.drain();
    expect(scanner.scanned).toEqual([pngBytes.length]);
    const clean = json(await ctx.app.inject({ method: "GET", url: `/v1/files/${file.id}`, headers: world.student.headers })).data;
    expect(clean.status).toBe("READY");
    expect(clean.scanStatus).toBe("CLEAN");
    expect(clean.downloadUrl).toBeTruthy();
    const stored = await ctx.container.db.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(stored.scanEngine).toBe("fake-clamav");
    expect(stored.scannedAt).not.toBeNull();
  });

  it("quarantines infected files and never issues a download URL", async () => {
    scanner.mode = "infected";
    const file = await uploadAvatar(world.student.headers);
    const original = await ctx.container.db.file.findUniqueOrThrow({ where: { id: file.id } });
    await ctx.outbox.drain();
    const stored = await ctx.container.db.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(stored.status).toBe("REJECTED");
    expect(stored.scanStatus).toBe("INFECTED");
    expect(stored.scanSignature).toBe("Eicar-Test-Signature");
    expect(stored.rejectedReason).toBe("MALWARE_DETECTED");
    expect(stored.quarantineKey).toBe(`quarantine/${original.objectKey}`);
    expect(ctx.container.storage).toBeInstanceOf(LocalStorageProvider);
    expect(existsSync(localPath(original.objectKey))).toBe(false);
    expect(existsSync(localPath(stored.quarantineKey!))).toBe(true);
    const described = json(await ctx.app.inject({ method: "GET", url: `/v1/files/${file.id}`, headers: world.student.headers })).data;
    expect(described.downloadUrl).toBeNull();
    const audit = await ctx.container.db.auditLog.findFirstOrThrow({ where: { action: "file.malware_detected", resourceId: file.id } });
    expect(audit.legalHold).toBe(true);
    expect(audit.outcome).toBe("DENIED");
  });

  it("retries through the outbox while the antivirus is unavailable", async () => {
    scanner.mode = "down";
    const readiness = json(await ctx.app.inject({ method: "GET", url: "/health/ready" }));
    expect(readiness.status).toBe("degraded");
    expect(readiness.checks.antivirus.status).toBe("down");
    const file = await uploadAvatar(world.student.headers);
    await ctx.outbox.drain();
    const waiting = await ctx.container.db.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(waiting.status).toBe("PROCESSING");
    const event = await ctx.container.db.outboxEvent.findFirstOrThrow({ where: { type: "file.scan", aggregateId: file.id } });
    expect(event.processedAt).toBeNull();
    expect(event.failedAt).toBeNull();
    expect(event.lastError).toContain("clamd unreachable");
    scanner.mode = "clean";
    await ctx.container.db.outboxEvent.update({ where: { id: event.id }, data: { availableAt: new Date(Date.now() - 1000) } });
    await ctx.outbox.drain();
    expect((await ctx.container.db.file.findUniqueOrThrow({ where: { id: file.id } })).status).toBe("READY");
  });
});

describe("streamed CSV exports", () => {
  it("writes exports in batches, expires them and re-checks access on download", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    for (let index = 0; index < 7; index += 1) {
      const learner = await createUser(ctx.container, { displayName: `Alumno ${index}` });
      await ctx.container.db.enrollment.create({ data: { userId: learner.id, courseId: course.id, institutionId: world.institution.id, status: "ACTIVE" } });
    }
    const requested = json(await ctx.app.inject({ method: "POST", url: "/v1/reports/exports", headers: world.teacher.headers, payload: { type: "course.enrollments", courseId: course.id } })).data;
    await ctx.outbox.drain();
    const status = json(await ctx.app.inject({ method: "GET", url: `/v1/reports/exports/${requested.id}`, headers: world.teacher.headers })).data;
    expect(status.status).toBe("COMPLETED");
    expect(status.rowCount).toBe(7);
    expect(status.expired).toBe(false);
    const target = new URL(status.downloadUrl);
    const csv = await ctx.app.inject({ method: "GET", url: `${target.pathname}${target.search}` });
    const lines = csv.body.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain("enrollment_id");
    const audit = await ctx.container.db.auditLog.findFirstOrThrow({ where: { action: "report.export.completed", resourceId: requested.id } });
    expect(audit.actorId).toBe(world.teacher.user.id);

    await ctx.container.db.roleAssignment.deleteMany({ where: { userId: world.teacher.user.id } });
    await ctx.container.authz.invalidate(world.teacher.user.id);
    const revoked = await ctx.app.inject({ method: "GET", url: `/v1/reports/exports/${requested.id}`, headers: world.teacher.headers });
    expect(revoked.statusCode).toBe(404);

    const expiredAt = new Date(Date.now() - 1000);
    const exported = await ctx.container.db.reportExport.update({ where: { id: requested.id }, data: { expiresAt: expiredAt } });
    await ctx.container.db.file.update({ where: { id: exported.fileId! }, data: { expiresAt: expiredAt } });
    const expired = json(await ctx.app.inject({ method: "GET", url: `/v1/reports/exports/${requested.id}`, headers: world.admin.headers }));
    expect(expired.error.code).toBe("NOT_FOUND");
    const report = await ctx.container.db.reportExport.findUniqueOrThrow({ where: { id: requested.id }, include: { file: true } });
    await ctx.container.retention.run();
    const file = await ctx.container.db.file.findUniqueOrThrow({ where: { id: report.fileId! } });
    expect(file.status).toBe("DELETED");
    expect(existsSync(localPath(report.file!.objectKey))).toBe(false);
  });
});

describe("log retention", () => {
  it("purges expired logs in batches without touching legal holds or recent security events", async () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 3600 * 1000);
    const base = { actorType: "SYSTEM" as const, outcome: "SUCCESS" as const };
    await ctx.container.db.auditLog.createMany({
      data: [
        { ...base, action: "course.updated", category: "ACADEMIC", occurredAt: daysAgo(400) },
        { ...base, action: "course.updated", category: "ACADEMIC", occurredAt: daysAgo(10) },
        { ...base, action: "auth.login.succeeded", category: "SECURITY", occurredAt: daysAgo(400) },
        { ...base, action: "auth.login.succeeded", category: "SECURITY", occurredAt: daysAgo(2000) },
        { ...base, action: "privacy.deletion.completed", category: "DATA", occurredAt: daysAgo(3000), legalHold: true },
      ],
    });
    await ctx.container.db.activityEvent.createMany({
      data: [
        { userId: world.student.user.id, verb: "lesson.viewed", occurredAt: daysAgo(800) },
        { userId: world.student.user.id, verb: "lesson.viewed", occurredAt: daysAgo(5) },
      ],
    });
    const before = await ctx.container.db.auditLog.count();
    const report = await ctx.container.retention.run();
    expect(report.auditLogs).toBe(2);
    expect(report.activityEvents).toBe(1);
    const remaining = await ctx.container.db.auditLog.findMany({ where: { occurredAt: { lt: daysAgo(100) } }, select: { action: true, category: true, legalHold: true } });
    expect(remaining).toEqual(
      expect.arrayContaining([
        { action: "auth.login.succeeded", category: "SECURITY", legalHold: false },
        { action: "privacy.deletion.completed", category: "DATA", legalHold: true },
      ]),
    );
    expect(remaining).toHaveLength(2);
    expect(await ctx.container.db.auditLog.count()).toBe(before - 2);
    const policy = await ctx.app.inject({ method: "GET", url: "/v1/admin/maintenance/retention", headers: world.student.headers });
    expect(policy.statusCode).toBe(403);
  });
});

describe("encryption key rotation", () => {
  it("re-encrypts every stored secret with the new primary key in resumable batches", async () => {
    const oldKeyring = testEnv["ENCRYPTION_KEYS"]!;
    const oldEncryptor = ctx.container.encryptor;
    const oldKeyId = oldEncryptor.activeKey;
    const users = [];
    for (let index = 0; index < 12; index += 1) users.push(await createUser(ctx.container));
    for (const user of users) {
      await ctx.container.db.mfaFactor.create({ data: { userId: user.id, type: "TOTP", status: "ACTIVE", secretCiphertext: oldEncryptor.encrypt(`SECRET${user.id}`, mfaSecretAad(user.id)) } });
    }
    const integrationUser = users[0]!;
    await ctx.container.db.integrationConnection.create({
      data: {
        userId: integrationUser.id,
        provider: "GOOGLE_CALENDAR",
        accessTokenCiphertext: oldEncryptor.encrypt("access-token-value", integrationTokenAad(integrationUser.id, "GOOGLE_CALENDAR", "access")),
        refreshTokenCiphertext: oldEncryptor.encrypt("refresh-token-value", integrationTokenAad(integrationUser.id, "GOOGLE_CALENDAR", "refresh")),
        scopes: [],
      },
    });
    await ctx.container.db.outboxEvent.deleteMany({});

    const newKey = `rotated:${randomBytes(32).toString("base64")}`;
    const rotated = await createTestContext({ env: { ENCRYPTION_KEYS: `${newKey},${oldKeyring}`, KEY_ROTATION_BATCH_SIZE: "10" } });
    try {
      const root = await createUserWithSession(rotated.app, rotated.container, { displayName: "Root" });
      await grantRole(rotated.container, root.user.id, "platform_admin", { type: RoleScope.PLATFORM });
      const denied = await rotated.app.inject({ method: "GET", url: "/v1/admin/security/encryption", headers: world.teacher.headers });
      expect(denied.statusCode).toBe(403);

      const before = json(await rotated.app.inject({ method: "GET", url: "/v1/admin/security/encryption", headers: root.headers })).data;
      expect(before.activeKeyId).toBe("rotated");
      expect(before.pendingRows).toBe(14);
      expect(before.keys.find((key: { keyId: string }) => key.keyId === oldKeyId).retirable).toBe(false);

      const started = await rotated.app.inject({ method: "POST", url: "/v1/admin/security/encryption/rotations", headers: root.headers });
      expect(started.statusCode).toBe(202);
      const runId = json(started).data.run.id;
      const concurrent = json(await rotated.app.inject({ method: "POST", url: "/v1/admin/security/encryption/rotations", headers: root.headers })).data;
      expect(concurrent.run.id).toBe(runId);

      await rotated.container.db.outboxEvent.deleteMany({ where: { type: "security.encryption.reencrypt" } });
      const firstStep = await rotated.container.keyRotation.runStep(runId, 1);
      expect(firstStep).toMatchObject({ completed: false, processed: 10 });
      const partial = await rotated.container.db.keyRotationRun.findUniqueOrThrow({ where: { id: runId } });
      expect(partial.status).toBe("RUNNING");
      expect(partial.processed).toBe(10);
      await rotated.outbox.drain();

      const run = await rotated.container.db.keyRotationRun.findUniqueOrThrow({ where: { id: runId } });
      expect(run.status).toBe("COMPLETED");
      expect(run.failed).toBe(0);
      const factors = await rotated.container.db.mfaFactor.findMany();
      expect(factors.every((factor) => FieldEncryptor.keyIdOf(factor.secretCiphertext) === "rotated")).toBe(true);
      for (const factor of factors) expect(rotated.container.encryptor.decrypt(factor.secretCiphertext, mfaSecretAad(factor.userId))).toBe(`SECRET${factor.userId}`);
      const integration = await rotated.container.db.integrationConnection.findFirstOrThrow();
      expect(rotated.container.encryptor.decrypt(integration.refreshTokenCiphertext!, integrationTokenAad(integration.userId, integration.provider, "refresh"))).toBe("refresh-token-value");

      const after = json(await rotated.app.inject({ method: "GET", url: "/v1/admin/security/encryption", headers: root.headers })).data;
      expect(after.pendingRows).toBe(0);
      expect(after.keys.find((key: { keyId: string }) => key.keyId === oldKeyId).retirable).toBe(true);
      const nothingLeft = json(await rotated.app.inject({ method: "POST", url: "/v1/admin/security/encryption/rotations", headers: root.headers })).data;
      expect(nothingLeft.run).toBeNull();
    } finally {
      await rotated.close();
    }
  });

  it("never loses data when a secret cannot be decrypted", async () => {
    const user = await createUser(ctx.container);
    const foreign = new FieldEncryptor([{ id: "lost", material: randomBytes(32).toString("base64") }]);
    const unreadable = foreign.encrypt("secret", mfaSecretAad(user.id));
    await ctx.container.db.mfaFactor.create({ data: { userId: user.id, type: "TOTP", status: "ACTIVE", secretCiphertext: unreadable } });
    const run = await ctx.container.keyRotation.runToCompletion();
    expect(run?.status).toBe("FAILED");
    expect(run?.failed).toBe(1);
    expect(run?.lastError).toContain("mfa_factors.secretCiphertext");
    const stored = await ctx.container.db.mfaFactor.findFirstOrThrow({ where: { userId: user.id } });
    expect(stored.secretCiphertext).toBe(unreadable);
  });
});
