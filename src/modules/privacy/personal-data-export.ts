import { Readable } from "node:stream";
import type { Database } from "../../core/database/prisma.js";

export const PERSONAL_DATA_FORMAT = "plataforma-educativa.personal-data";
export const PERSONAL_DATA_VERSION = 1;
export const DEFAULT_EXPORT_BATCH_SIZE = 500;

type Row = Record<string, unknown> & { id: string };
type BatchLoader = (cursor: string | undefined, take: number) => Promise<Row[]>;

export function serializeForExport(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    return item;
  });
}

export interface ExportSection {
  name: string;
  single?: () => Promise<Record<string, unknown> | null>;
  batches?: BatchLoader;
}

export function personalDataSections(db: Database, userId: string): ExportSection[] {
  const after = (cursor: string | undefined) => (cursor ? { id: { gt: cursor } } : {});
  return [
    {
      name: "account",
      single: () =>
        db.user.findUnique({
          where: { id: userId },
          select: { id: true, email: true, displayName: true, status: true, emailVerifiedAt: true, mfaEnabled: true, createdAt: true, lastLoginAt: true, passwordChangedAt: true },
        }),
    },
    { name: "profile", single: () => db.userProfile.findUnique({ where: { userId } }) },
    { name: "preferences", single: () => db.userPreference.findUnique({ where: { userId } }) },
    {
      name: "notificationPreferences",
      batches: (cursor, take) => db.notificationPreference.findMany({ where: { userId, ...after(cursor) }, orderBy: { id: "asc" }, take, select: { id: true, category: true, channel: true, enabled: true, updatedAt: true } }),
    },
    {
      name: "devices",
      batches: (cursor, take) =>
        db.userDevice.findMany({ where: { userId, ...after(cursor) }, orderBy: { id: "asc" }, take, select: { id: true, name: true, platform: true, userAgent: true, lastIp: true, firstSeenAt: true, lastSeenAt: true } }),
    },
    {
      name: "sessions",
      batches: (cursor, take) =>
        db.session.findMany({
          where: { userId, ...after(cursor) },
          orderBy: { id: "asc" },
          take,
          select: { id: true, platform: true, authMethod: true, authProvider: true, mfaVerified: true, ipAddress: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true, revokedAt: true, revokedReason: true },
        }),
    },
    {
      name: "externalIdentities",
      batches: (cursor, take) =>
        db.externalIdentity.findMany({ where: { userId, ...after(cursor) }, orderBy: { id: "asc" }, take, select: { id: true, provider: true, email: true, displayName: true, linkedAt: true, lastUsedAt: true } }),
    },
    {
      name: "integrations",
      batches: (cursor, take) =>
        db.integrationConnection.findMany({
          where: { userId, ...after(cursor) },
          orderBy: { id: "asc" },
          take,
          select: { id: true, provider: true, status: true, externalAccountEmail: true, scopes: true, lastSyncedAt: true, createdAt: true },
        }),
    },
    {
      name: "pushSubscriptions",
      batches: (cursor, take) =>
        db.pushSubscription.findMany({ where: { userId, ...after(cursor) }, orderBy: { id: "asc" }, take, select: { id: true, provider: true, platform: true, createdAt: true, lastUsedAt: true, revokedAt: true } }),
    },
    {
      name: "twoFactor",
      batches: (cursor, take) => db.mfaFactor.findMany({ where: { userId, ...after(cursor) }, orderBy: { id: "asc" }, take, select: { id: true, type: true, status: true, createdAt: true, confirmedAt: true } }),
    },
    {
      name: "memberships",
      batches: (cursor, take) =>
        db.institutionMembership.findMany({
          where: { userId, ...after(cursor) },
          orderBy: { id: "asc" },
          take,
          select: { id: true, memberType: true, status: true, joinedAt: true, institution: { select: { id: true, name: true, slug: true } } },
        }),
    },
    {
      name: "roleAssignments",
      batches: (cursor, take) =>
        db.roleAssignment.findMany({
          where: { userId, ...after(cursor) },
          orderBy: { id: "asc" },
          take,
          select: { id: true, scopeType: true, scopeKey: true, createdAt: true, expiresAt: true, role: { select: { key: true, name: true } } },
        }),
    },
    {
      name: "enrollments",
      batches: (cursor, take) =>
        db.enrollment.findMany({
          where: { userId, ...after(cursor) },
          orderBy: { id: "asc" },
          take,
          select: {
            id: true,
            status: true,
            source: true,
            progressPercent: true,
            finalScorePercent: true,
            enrolledAt: true,
            activatedAt: true,
            completedAt: true,
            cancelledAt: true,
            lastActivityAt: true,
            course: { select: { id: true, title: true } },
            events: { select: { fromStatus: true, toStatus: true, reason: true, occurredAt: true }, orderBy: { occurredAt: "asc" } },
          },
        }),
    },
    {
      name: "lessonProgress",
      batches: (cursor, take) =>
        db.lessonProgress.findMany({
          where: { userId, ...after(cursor) },
          orderBy: { id: "asc" },
          take,
          select: { id: true, courseId: true, lessonId: true, status: true, progressPercent: true, timeSpentSeconds: true, firstViewedAt: true, lastViewedAt: true, completedAt: true },
        }),
    },
    {
      name: "activity",
      batches: (cursor, take) =>
        db.activityEvent.findMany({ where: { userId, ...after(cursor) }, orderBy: { id: "asc" }, take, select: { id: true, verb: true, courseId: true, lessonId: true, data: true, occurredAt: true } }),
    },
    {
      name: "certificates",
      batches: (cursor, take) =>
        db.certificate.findMany({ where: { userId, ...after(cursor) }, orderBy: { id: "asc" }, take, select: { id: true, verificationCode: true, status: true, snapshot: true, issuedAt: true, revokedAt: true } }),
    },
    {
      name: "assessmentAttempts",
      batches: (cursor, take) =>
        db.assessmentAttempt.findMany({
          where: { userId, ...after(cursor) },
          orderBy: { id: "asc" },
          take,
          select: {
            id: true,
            attemptNumber: true,
            status: true,
            startedAt: true,
            submittedAt: true,
            scorePoints: true,
            maxPoints: true,
            scorePercent: true,
            passed: true,
            extraTimeSeconds: true,
            assessment: { select: { id: true, title: true } },
            answers: { select: { attemptQuestionId: true, response: true, awardedPoints: true, feedback: true, savedAt: true } },
          },
        }),
    },
    {
      name: "assessmentResults",
      batches: (cursor, take) =>
        db.assessmentResult.findMany({ where: { userId, ...after(cursor) }, orderBy: { id: "asc" }, take, select: { id: true, assessmentId: true, attemptsCount: true, scorePercent: true, passed: true, updatedAt: true } }),
    },
    {
      name: "accommodations",
      batches: (cursor, take) =>
        db.assessmentAccommodation.findMany({ where: { userId, ...after(cursor) }, orderBy: { id: "asc" }, take, select: { id: true, assessmentId: true, extraTimeSeconds: true, reason: true, createdAt: true, revokedAt: true } }),
    },
    {
      name: "notifications",
      batches: (cursor, take) =>
        db.notification.findMany({ where: { userId, ...after(cursor) }, orderBy: { id: "asc" }, take, select: { id: true, category: true, type: true, data: true, readAt: true, createdAt: true } }),
    },
    {
      name: "messages",
      batches: (cursor, take) =>
        db.message.findMany({ where: { senderId: userId, ...after(cursor) }, orderBy: { id: "asc" }, take, select: { id: true, conversationId: true, body: true, createdAt: true, editedAt: true, deletedAt: true } }),
    },
    {
      name: "files",
      batches: (cursor, take) =>
        db.file.findMany({
          where: { ownerId: userId, ...after(cursor) },
          orderBy: { id: "asc" },
          take,
          select: { id: true, purpose: true, status: true, originalName: true, mimeType: true, sizeBytes: true, createdAt: true, deletedAt: true },
        }),
    },
    {
      name: "privacyRequests",
      batches: (cursor, take) =>
        db.privacyRequest.findMany({ where: { userId, ...after(cursor) }, orderBy: { id: "asc" }, take, select: { id: true, type: true, status: true, requestedAt: true, scheduledFor: true, completedAt: true, cancelledAt: true } }),
    },
    {
      name: "securityEvents",
      batches: (cursor, take) =>
        db.auditLog.findMany({
          where: { actorId: userId, category: "SECURITY", ...after(cursor) },
          orderBy: { id: "asc" },
          take,
          select: { id: true, action: true, outcome: true, occurredAt: true, ipAddress: true, userAgent: true },
        }),
    },
  ];
}

export interface ExportCounter {
  records: number;
  sections: Record<string, number>;
}

export function personalDataStream(sections: ExportSection[], meta: { userId: string; generatedAt: Date }, counter: ExportCounter, batchSize = DEFAULT_EXPORT_BATCH_SIZE): Readable {
  async function* chunks(): AsyncGenerator<string> {
    yield `{"format":${serializeForExport(PERSONAL_DATA_FORMAT)},"version":${PERSONAL_DATA_VERSION},"generatedAt":${serializeForExport(meta.generatedAt)},"userId":${serializeForExport(meta.userId)},"sections":{`;
    let firstSection = true;
    for (const section of sections) {
      yield `${firstSection ? "" : ","}${serializeForExport(section.name)}:`;
      firstSection = false;
      if (section.single) {
        const value = await section.single();
        counter.sections[section.name] = value ? 1 : 0;
        counter.records += value ? 1 : 0;
        yield serializeForExport(value);
        continue;
      }
      yield "[";
      let cursor: string | undefined;
      let count = 0;
      for (;;) {
        const batch = await section.batches!(cursor, batchSize);
        for (const row of batch) {
          yield `${count === 0 ? "" : ","}${serializeForExport(row)}`;
          count += 1;
        }
        if (batch.length < batchSize) break;
        cursor = batch[batch.length - 1]!.id;
      }
      counter.sections[section.name] = count;
      counter.records += count;
      yield "]";
    }
    yield "}}";
  }
  return Readable.from(chunks(), { objectMode: false });
}
