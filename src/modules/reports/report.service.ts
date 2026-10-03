import { Readable } from "node:stream";
import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import type { AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import type { OutboxService } from "../../core/events/outbox.js";
import { ErrorCode, badRequest, notFound } from "../../core/http/errors.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { RateLimitService } from "../../core/security/rate-limiter.js";
import type { StorageProvider } from "../../core/storage/storage-provider.js";
import { ActorType, EnrollmentStatus, FilePurpose, FileScanStatus, FileStatus, FileVisibility, MembershipStatus, ReportExportStatus } from "../../generated/prisma/enums.js";
import type { AssessmentService } from "../assessments/assessment.service.js";
import type { CourseAccessService } from "../courses/course-access.service.js";

export const REPORT_EXPORT_EVENT = "report.export";
export const exportTypes = ["course.enrollments", "assessment.results", "institution.members"] as const;
export type ExportType = (typeof exportTypes)[number];

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
export const REPORT_EXPORT_BATCH_SIZE = 1000;
const STALE_PROCESSING_MS = 30 * 60 * 1000;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") text = value.toString();
  else text = JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",");
}

export class ReportService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthorizationService,
    private readonly access: CourseAccessService,
    private readonly assessments: AssessmentService,
    private readonly outbox: OutboxService,
    private readonly storage: StorageProvider,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
    private readonly urlTtlSeconds: number,
    private readonly exportTtlHours: number,
    private readonly batchSize = REPORT_EXPORT_BATCH_SIZE,
  ) {}

  async institutionOverview(actorId: string, institutionId: string) {
    await this.authz.require(actorId, Permission.ReportRead, { institutionId }, { hideAs: "Institution" });
    const since30 = new Date(Date.now() - 30 * DAY_MS);
    const since7 = new Date(Date.now() - 7 * DAY_MS);
    const [members, courses, enrollments, completions30d, activeLearners7d, progress] = await Promise.all([
      this.db.institutionMembership.groupBy({ by: ["memberType"], where: { institutionId, status: MembershipStatus.ACTIVE }, _count: { _all: true } }),
      this.db.course.groupBy({ by: ["status"], where: { institutionId, deletedAt: null }, _count: { _all: true } }),
      this.db.enrollment.groupBy({ by: ["status"], where: { institutionId }, _count: { _all: true } }),
      this.db.enrollment.count({ where: { institutionId, completedAt: { gte: since30 } } }),
      this.db.enrollment.count({ where: { institutionId, lastActivityAt: { gte: since7 } } }),
      this.db.enrollment.aggregate({ where: { institutionId, status: EnrollmentStatus.ACTIVE }, _avg: { progressPercent: true } }),
    ]);
    return {
      institutionId,
      membersByType: Object.fromEntries(members.map((item) => [item.memberType, item._count._all])),
      coursesByStatus: Object.fromEntries(courses.map((item) => [item.status, item._count._all])),
      enrollmentsByStatus: Object.fromEntries(enrollments.map((item) => [item.status, item._count._all])),
      completionsLast30Days: completions30d,
      activeLearnersLast7Days: activeLearners7d,
      averageActiveProgressPercent: progress._avg.progressPercent === null ? null : Math.round(progress._avg.progressPercent * 100) / 100,
    };
  }

  async courseProgress(actorId: string, courseId: string) {
    await this.access.requireManage(actorId, courseId, Permission.ReportRead);
    const inactiveSince = new Date(Date.now() - 14 * DAY_MS);
    const [byStatus, averages, timeSpent, modules, atRisk] = await Promise.all([
      this.db.enrollment.groupBy({ by: ["status"], where: { courseId }, _count: { _all: true } }),
      this.db.enrollment.aggregate({ where: { courseId, status: { in: [EnrollmentStatus.ACTIVE, EnrollmentStatus.COMPLETED] } }, _avg: { progressPercent: true, finalScorePercent: true } }),
      this.db.lessonProgress.aggregate({ where: { courseId }, _sum: { timeSpentSeconds: true } }),
      this.db.$queryRaw<Array<{ moduleId: string; title: string; learners: bigint; completed: bigint; avgPercent: number | null }>>`
        SELECT m."id" AS "moduleId", m."title" AS "title",
               COUNT(sp."id") AS "learners",
               COUNT(*) FILTER (WHERE sp."progressPercent" = 100) AS "completed",
               AVG(sp."progressPercent")::float AS "avgPercent"
        FROM "course_modules" m
        LEFT JOIN "section_progress" sp ON sp."sectionId" = m."id" AND sp."sectionType" = 'MODULE'
        WHERE m."courseId" = ${courseId}::uuid
        GROUP BY m."id", m."title", m."position"
        ORDER BY m."position"`,
      this.db.enrollment.findMany({
        where: { courseId, status: EnrollmentStatus.ACTIVE, progressPercent: { lt: 50 }, OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: inactiveSince } }] },
        select: { id: true, progressPercent: true, lastActivityAt: true, user: { select: { id: true, displayName: true, email: true } } },
        orderBy: [{ lastActivityAt: { sort: "asc", nulls: "first" } }],
        take: 50,
      }),
    ]);
    const counts = Object.fromEntries(byStatus.map((item) => [item.status, item._count._all]));
    const started = (counts["ACTIVE"] ?? 0) + (counts["COMPLETED"] ?? 0);
    return {
      courseId,
      enrollmentsByStatus: counts,
      completionRate: started === 0 ? null : Math.round(((counts["COMPLETED"] ?? 0) / started) * 10_000) / 100,
      averageProgressPercent: averages._avg.progressPercent === null ? null : Math.round(averages._avg.progressPercent * 100) / 100,
      averageFinalScorePercent: averages._avg.finalScorePercent === null ? null : Number(averages._avg.finalScorePercent),
      totalTimeSpentSeconds: timeSpent._sum.timeSpentSeconds ?? 0,
      modules: modules.map((row) => ({
        moduleId: row.moduleId,
        title: row.title,
        learnersWithProgress: Number(row.learners),
        learnersCompleted: Number(row.completed),
        averageProgressPercent: row.avgPercent === null ? null : Math.round(row.avgPercent * 100) / 100,
      })),
      atRiskLearners: atRisk.map((item) => ({ enrollmentId: item.id, progressPercent: item.progressPercent, lastActivityAt: item.lastActivityAt, user: item.user })),
    };
  }

  async requestExport(actorId: string, input: { type: ExportType; courseId?: string; assessmentId?: string; institutionId?: string }, meta: RequestMeta) {
    await this.rateLimits.consume("expensiveUser", actorId);
    let institutionId: string;
    const params: Record<string, string> = {};
    switch (input.type) {
      case "course.enrollments": {
        if (!input.courseId) throw badRequest(ErrorCode.VALIDATION_FAILED, "courseId is required");
        institutionId = (await this.access.requireManage(actorId, input.courseId, Permission.ReportExport)).institutionId;
        params["courseId"] = input.courseId;
        break;
      }
      case "assessment.results": {
        if (!input.assessmentId) throw badRequest(ErrorCode.VALIDATION_FAILED, "assessmentId is required");
        const assessment = await this.assessments.find(input.assessmentId);
        institutionId = (await this.access.requireManage(actorId, assessment.courseId, Permission.ReportExport)).institutionId;
        params["assessmentId"] = input.assessmentId;
        break;
      }
      default: {
        if (!input.institutionId) throw badRequest(ErrorCode.VALIDATION_FAILED, "institutionId is required");
        await this.authz.require(actorId, Permission.ReportExport, { institutionId: input.institutionId }, { hideAs: "Institution" });
        institutionId = input.institutionId;
        params["institutionId"] = input.institutionId;
      }
    }
    const created = await this.db.$transaction(async (tx) => {
      const exportRow = await tx.reportExport.create({ data: { requestedById: actorId, institutionId, type: input.type, params } });
      await this.outbox.enqueue(tx, { type: REPORT_EXPORT_EVENT, aggregateType: "report_export", aggregateId: exportRow.id, payload: { exportId: exportRow.id }, requestId: meta.requestId });
      await this.audit.record({ action: "report.export.requested", category: AuditCategory.DATA, actorId, resourceType: "report_export", resourceId: exportRow.id, institutionId, metadata: { type: input.type }, meta }, tx);
      return exportRow;
    });
    return this.presentExport(created, null);
  }

  async getExport(actorId: string, exportId: string) {
    const row = await this.db.reportExport.findFirst({ where: { id: exportId, requestedById: actorId }, include: { file: true } });
    if (!row) throw notFound("Export");
    if (row.institutionId && !(await this.authz.can(actorId, Permission.ReportExport, { institutionId: row.institutionId })) && !(await this.canStillExport(actorId, row.params as Record<string, string>))) {
      throw notFound("Export");
    }
    const expired = row.expiresAt !== null && row.expiresAt <= new Date();
    const url =
      row.status === ReportExportStatus.COMPLETED && row.file && !expired && row.file.status === FileStatus.READY
        ? await this.storage.createDownloadUrl(row.file.objectKey, { fileName: row.file.originalName, contentType: row.file.mimeType, expiresInSeconds: this.urlTtlSeconds })
        : null;
    return this.presentExport(row, url);
  }

  private async canStillExport(actorId: string, params: Record<string, string>): Promise<boolean> {
    try {
      if (params["courseId"]) {
        await this.access.requireManage(actorId, params["courseId"], Permission.ReportExport);
        return true;
      }
      if (params["assessmentId"]) {
        const assessment = await this.assessments.find(params["assessmentId"]);
        await this.access.requireManage(actorId, assessment.courseId, Permission.ReportExport);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private presentExport(
    row: { id: string; type: string; status: ReportExportStatus; error: string | null; createdAt: Date; completedAt: Date | null; expiresAt: Date | null; rowCount: number | null },
    downloadUrl: string | null,
  ) {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      error: row.error,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      expiresAt: row.expiresAt,
      rowCount: row.rowCount,
      expired: row.expiresAt !== null && row.expiresAt <= new Date(),
      downloadUrl,
    };
  }

  private async *rows(type: ExportType, params: Record<string, string>): AsyncGenerator<unknown[]> {
    if (type === "course.enrollments") {
      yield ["enrollment_id", "user_id", "email", "display_name", "status", "progress_percent", "final_score_percent", "enrolled_at", "completed_at", "last_activity_at"];
      let cursor: string | undefined;
      for (;;) {
        const batch = await this.db.enrollment.findMany({
          where: { courseId: params["courseId"], ...(cursor ? { id: { gt: cursor } } : {}) },
          include: { user: { select: { email: true, displayName: true } } },
          orderBy: { id: "asc" },
          take: this.batchSize,
        });
        for (const row of batch) {
          yield [row.id, row.userId, row.user.email, row.user.displayName, row.status, row.progressPercent, row.finalScorePercent?.toString() ?? "", row.enrolledAt, row.completedAt, row.lastActivityAt];
        }
        if (batch.length < this.batchSize) return;
        cursor = batch[batch.length - 1]!.id;
      }
    }
    if (type === "assessment.results") {
      yield ["attempt_id", "user_id", "email", "display_name", "attempt_number", "status", "score_points", "max_points", "score_percent", "passed", "started_at", "submitted_at"];
      let cursor: string | undefined;
      for (;;) {
        const batch = await this.db.assessmentAttempt.findMany({
          where: { assessmentId: params["assessmentId"], ...(cursor ? { id: { gt: cursor } } : {}) },
          include: { user: { select: { email: true, displayName: true } } },
          orderBy: { id: "asc" },
          take: this.batchSize,
        });
        for (const row of batch) {
          yield [row.id, row.userId, row.user.email, row.user.displayName, row.attemptNumber, row.status, row.scorePoints?.toString() ?? "", row.maxPoints.toString(), row.scorePercent?.toString() ?? "", row.passed, row.startedAt, row.submittedAt];
        }
        if (batch.length < this.batchSize) return;
        cursor = batch[batch.length - 1]!.id;
      }
    }
    yield ["membership_id", "user_id", "email", "display_name", "member_type", "status", "external_id", "joined_at"];
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.db.institutionMembership.findMany({
        where: { institutionId: params["institutionId"], ...(cursor ? { id: { gt: cursor } } : {}) },
        include: { user: { select: { email: true, displayName: true } } },
        orderBy: { id: "asc" },
        take: this.batchSize,
      });
      for (const row of batch) yield [row.id, row.userId, row.user.email, row.user.displayName, row.memberType, row.status, row.externalId, row.joinedAt];
      if (batch.length < this.batchSize) return;
      cursor = batch[batch.length - 1]!.id;
    }
  }

  csvStream(type: ExportType, params: Record<string, string>, counter: { rows: number }): Readable {
    const rows = this.rows(type, params);
    async function* lines(): AsyncGenerator<string> {
      yield "\uFEFF";
      let header = true;
      for await (const values of rows) {
        if (header) header = false;
        else counter.rows += 1;
        yield `${csvRow(values)}\r\n`;
      }
    }
    return Readable.from(lines(), { objectMode: false });
  }

  async generate(exportId: string): Promise<void> {
    const startedAt = new Date();
    const claimed = await this.db.reportExport.updateMany({
      where: {
        id: exportId,
        OR: [
          { status: { in: [ReportExportStatus.PENDING, ReportExportStatus.FAILED] } },
          { status: ReportExportStatus.PROCESSING, OR: [{ startedAt: null }, { startedAt: { lt: new Date(startedAt.getTime() - STALE_PROCESSING_MS) } }] },
        ],
      },
      data: { status: ReportExportStatus.PROCESSING, startedAt },
    });
    if (claimed.count === 0) return;
    const row = await this.db.reportExport.findUniqueOrThrow({ where: { id: exportId } });
    const objectKey = `report_export/${exportId}.csv`;
    try {
      const counter = { rows: 0 };
      const { sizeBytes } = await this.storage.putStream(objectKey, this.csvStream(row.type as ExportType, row.params as Record<string, string>, counter), "text/csv");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.exportTtlHours * HOUR_MS);
      await this.db.$transaction(async (tx) => {
        const file = await tx.file.create({
          data: {
            ownerId: row.requestedById,
            institutionId: row.institutionId,
            purpose: FilePurpose.REPORT_EXPORT,
            status: FileStatus.READY,
            scanStatus: FileScanStatus.NOT_REQUIRED,
            visibility: FileVisibility.PRIVATE,
            storageProvider: this.storage.name,
            objectKey,
            originalName: `${row.type.replace(/\./g, "-")}-${now.toISOString().slice(0, 10)}.csv`,
            mimeType: "text/csv",
            declaredSizeBytes: BigInt(sizeBytes),
            sizeBytes: BigInt(sizeBytes),
            uploadedAt: now,
            readyAt: now,
            expiresAt,
          },
        });
        await tx.reportExport.update({ where: { id: exportId }, data: { status: ReportExportStatus.COMPLETED, fileId: file.id, completedAt: now, expiresAt, rowCount: counter.rows, error: null } });
        await this.audit.record(
          {
            action: "report.export.completed",
            category: AuditCategory.DATA,
            actorId: row.requestedById,
            actorType: ActorType.SYSTEM,
            resourceType: "report_export",
            resourceId: exportId,
            institutionId: row.institutionId,
            metadata: { type: row.type, rows: counter.rows, sizeBytes, expiresAt: expiresAt.toISOString() },
          },
          tx,
        );
      });
    } catch (error) {
      await this.storage.delete(objectKey).catch(() => undefined);
      await this.db.reportExport.update({ where: { id: exportId }, data: { status: ReportExportStatus.FAILED, error: (error instanceof Error ? error.message : "failed").slice(0, 1000) } });
      throw error;
    }
  }
}
