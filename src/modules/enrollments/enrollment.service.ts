import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database, Tx } from "../../core/database/prisma.js";
import { AppError, ErrorCode, conflict, forbidden, notFound } from "../../core/http/errors.js";
import { buildCursorPage, decodeCursor, offsetMetaOf } from "../../core/http/pagination.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { Enrollment, Prisma } from "../../generated/prisma/client.js";
import {
  AccessModel,
  CohortStatus,
  ContentStatus,
  CourseStatus,
  CourseVisibility,
  EnrollmentPolicy,
  EnrollmentSource,
  EnrollmentStatus,
  NotificationCategory,
} from "../../generated/prisma/enums.js";
import type { PlatformSettingsService } from "../admin/platform-settings.service.js";
import type { CourseAccessService, CourseRecord } from "../courses/course-access.service.js";
import { NotificationType } from "../notifications/notification-catalog.js";
import type { NotificationService } from "../notifications/notification.service.js";

const openStatuses: EnrollmentStatus[] = [EnrollmentStatus.ACTIVE, EnrollmentStatus.COMPLETED, EnrollmentStatus.PENDING_APPROVAL];
const reopenableStatuses: EnrollmentStatus[] = [EnrollmentStatus.CANCELLED, EnrollmentStatus.EXPIRED, EnrollmentStatus.REJECTED];

export interface EnrollOptions {
  cohortId?: string | null;
  source?: EnrollmentSource;
  bypassWindows?: boolean;
  actorId?: string;
}

export class EnrollmentService {
  constructor(
    private readonly db: Database,
    private readonly access: CourseAccessService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly settings: PlatformSettingsService,
  ) {}

  private assertWindow(opensAt: Date | null, closesAt: Date | null, now: Date) {
    if ((opensAt && opensAt > now) || (closesAt && closesAt <= now)) {
      throw new AppError(409, ErrorCode.ENROLLMENT_CLOSED, "Enrollment window is closed");
    }
  }

  private async claimSeat(tx: Tx, course: CourseRecord, cohortId: string | null): Promise<void> {
    const courseClaim = await tx.course.updateMany({
      where: { id: course.id, OR: [{ capacity: null }, { seatsTaken: { lt: tx.course.fields.capacity } }] },
      data: { seatsTaken: { increment: 1 } },
    });
    if (courseClaim.count === 0) throw new AppError(409, ErrorCode.ENROLLMENT_FULL, "No seats available");
    if (cohortId) {
      const cohortClaim = await tx.cohort.updateMany({
        where: { id: cohortId, OR: [{ capacity: null }, { seatsTaken: { lt: tx.cohort.fields.capacity } }] },
        data: { seatsTaken: { increment: 1 } },
      });
      if (cohortClaim.count === 0) throw new AppError(409, ErrorCode.ENROLLMENT_FULL, "No seats available in the cohort");
    }
  }

  private async releaseSeat(tx: Tx, enrollment: Pick<Enrollment, "courseId" | "cohortId" | "holdsSeat" | "id">): Promise<void> {
    if (!enrollment.holdsSeat) return;
    await tx.course.updateMany({ where: { id: enrollment.courseId, seatsTaken: { gt: 0 } }, data: { seatsTaken: { decrement: 1 } } });
    if (enrollment.cohortId) {
      await tx.cohort.updateMany({ where: { id: enrollment.cohortId, seatsTaken: { gt: 0 } }, data: { seatsTaken: { decrement: 1 } } });
    }
    await tx.enrollment.update({ where: { id: enrollment.id }, data: { holdsSeat: false } });
  }

  async requiredLessonCount(client: Tx | Database, courseId: string): Promise<number> {
    return client.lesson.count({ where: { courseId, isRequired: true, status: ContentStatus.PUBLISHED } });
  }

  async prerequisitesMet(userId: string, courseId: string): Promise<{ met: boolean; missing: string[] }> {
    const prerequisites = await this.db.coursePrerequisite.findMany({ where: { courseId }, select: { prerequisiteId: true } });
    if (prerequisites.length === 0) return { met: true, missing: [] };
    const completed = await this.db.enrollment.findMany({
      where: { userId, status: EnrollmentStatus.COMPLETED, courseId: { in: prerequisites.map((item) => item.prerequisiteId) } },
      select: { courseId: true },
    });
    const done = new Set(completed.map((item) => item.courseId));
    const missing = prerequisites.map((item) => item.prerequisiteId).filter((id) => !done.has(id));
    return { met: missing.length === 0, missing };
  }

  async enroll(userId: string, courseId: string, options: EnrollOptions, meta: RequestMeta): Promise<Enrollment> {
    const source = options.source ?? EnrollmentSource.SELF;
    const course = source === EnrollmentSource.SELF ? await this.access.requireVisible(userId, courseId) : await this.access.findCourse(courseId);
    if (course.status !== CourseStatus.PUBLISHED) throw new AppError(409, ErrorCode.ENROLLMENT_CLOSED, "Course is not open");
    const now = new Date();

    if (source === EnrollmentSource.SELF) {
      if (course.enrollmentPolicy === EnrollmentPolicy.CLOSED || course.enrollmentPolicy === EnrollmentPolicy.INVITE_ONLY) {
        throw new AppError(409, ErrorCode.ENROLLMENT_CLOSED, "Enrollment is not open");
      }
      if (course.accessModel === AccessModel.PAID) {
        throw conflict(ErrorCode.BUSINESS_RULE, "Paid enrollment is not available yet", { reason: "PAYMENT_REQUIRED" });
      }
      if ((await this.settings.get("enrollment.requireInstitutionMembershipForPublicCourses")) && !(await this.access.isInstitutionMember(userId, course.institutionId))) {
        throw forbidden("Institution membership required");
      }
      const prerequisites = await this.prerequisitesMet(userId, courseId);
      if (!prerequisites.met) throw new AppError(409, ErrorCode.PREREQUISITES_NOT_MET, "Prerequisites not met", { details: { missing: prerequisites.missing } });
    }
    if (!options.bypassWindows) this.assertWindow(course.enrollmentOpensAt, course.enrollmentClosesAt, now);

    let cohortId: string | null = options.cohortId ?? null;
    if (cohortId) {
      const cohort = await this.db.cohort.findFirst({ where: { id: cohortId, courseId } });
      if (!cohort) throw notFound("Cohort");
      if (!options.bypassWindows) {
        if (cohort.status !== CohortStatus.OPEN && cohort.status !== CohortStatus.RUNNING) throw new AppError(409, ErrorCode.ENROLLMENT_CLOSED, "Cohort is not open");
        this.assertWindow(cohort.enrollmentOpensAt, cohort.enrollmentClosesAt, now);
      }
    } else {
      cohortId = null;
    }

    const needsApproval = source === EnrollmentSource.SELF && course.enrollmentPolicy === EnrollmentPolicy.APPROVAL;
    const targetStatus = needsApproval ? EnrollmentStatus.PENDING_APPROVAL : EnrollmentStatus.ACTIVE;

    const enrollment = await this.db.$transaction(async (tx) => {
      const existing = await tx.enrollment.findUnique({ where: { userId_courseId: { userId, courseId } } });
      if (existing && openStatuses.includes(existing.status)) throw conflict(ErrorCode.ALREADY_ENROLLED, "Already enrolled");
      if (existing && !reopenableStatuses.includes(existing.status)) throw conflict(ErrorCode.BUSINESS_RULE, "Enrollment cannot be reopened", { status: existing.status });
      if (targetStatus === EnrollmentStatus.ACTIVE) await this.claimSeat(tx, course, cohortId);
      const requiredLessons = await this.requiredLessonCount(tx, courseId);
      const data = {
        status: targetStatus,
        source,
        cohortId,
        holdsSeat: targetStatus === EnrollmentStatus.ACTIVE,
        activatedAt: targetStatus === EnrollmentStatus.ACTIVE ? now : null,
        cancelledAt: null,
        completedAt: null,
        statusReason: null,
        requiredLessons,
        enrolledAt: now,
      };
      const saved = existing
        ? await tx.enrollment.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } })
        : await tx.enrollment.create({ data: { userId, courseId, institutionId: course.institutionId, ...data } });
      await tx.enrollmentEvent.create({ data: { enrollmentId: saved.id, fromStatus: existing?.status ?? null, toStatus: targetStatus, actorId: options.actorId ?? userId } });
      await tx.activityEvent.create({ data: { userId, courseId, enrollmentId: saved.id, verb: targetStatus === EnrollmentStatus.ACTIVE ? "enrollment.activated" : "enrollment.requested" } });
      await this.notifications.notify(tx, {
        userId,
        category: NotificationCategory.ACADEMIC,
        type: targetStatus === EnrollmentStatus.ACTIVE ? NotificationType.EnrollmentActivated : NotificationType.EnrollmentPending,
        params: { course: course.title },
        target: { kind: "course", id: courseId },
        institutionId: course.institutionId,
        requestId: meta.requestId,
      });
      if (needsApproval) await this.notifyApprovers(tx, course, userId, meta);
      await this.audit.record(
        {
          action: "enrollment.created",
          category: AuditCategory.ACADEMIC,
          actorId: options.actorId ?? userId,
          resourceType: "enrollment",
          resourceId: saved.id,
          institutionId: course.institutionId,
          metadata: { courseId, status: targetStatus, source },
          meta,
        },
        tx,
      );
      return saved;
    });
    return enrollment;
  }

  private async notifyApprovers(tx: Tx, course: CourseRecord, studentId: string, meta: RequestMeta) {
    const approvers = await tx.roleAssignment.findMany({ where: { courseId: course.id, role: { key: "course_instructor" } }, select: { userId: true }, take: 20 });
    const student = await tx.user.findUniqueOrThrow({ where: { id: studentId }, select: { displayName: true } });
    for (const approver of approvers) {
      await this.notifications.notify(tx, {
        userId: approver.userId,
        category: NotificationCategory.ACADEMIC,
        type: NotificationType.EnrollmentRequested,
        params: { course: course.title, student: student.displayName },
        target: { kind: "course-enrollments", id: course.id },
        institutionId: course.institutionId,
        requestId: meta.requestId,
      });
    }
  }

  async cancel(userId: string, enrollmentId: string, reason: string | null, meta: RequestMeta) {
    const enrollment = await this.db.enrollment.findFirst({ where: { id: enrollmentId, userId } });
    if (!enrollment) throw notFound("Enrollment");
    if (enrollment.status !== EnrollmentStatus.ACTIVE && enrollment.status !== EnrollmentStatus.PENDING_APPROVAL) {
      throw conflict(ErrorCode.BUSINESS_RULE, "Only active or pending enrollments can be cancelled");
    }
    return this.changeStatus(enrollment, EnrollmentStatus.CANCELLED, userId, reason, meta);
  }

  private async changeStatus(enrollment: Enrollment, target: EnrollmentStatus, actorId: string, reason: string | null, meta: RequestMeta) {
    const course = await this.access.findCourse(enrollment.courseId);
    return this.db.$transaction(async (tx) => {
      const claimed = await tx.enrollment.updateMany({
        where: { id: enrollment.id, version: enrollment.version },
        data: {
          status: target,
          statusReason: reason,
          version: { increment: 1 },
          ...(target === EnrollmentStatus.CANCELLED ? { cancelledAt: new Date() } : {}),
          ...(target === EnrollmentStatus.ACTIVE && !enrollment.activatedAt ? { activatedAt: new Date() } : {}),
        },
      });
      if (claimed.count === 0) throw conflict(ErrorCode.VERSION_CONFLICT, "Enrollment changed concurrently, retry");
      if (target === EnrollmentStatus.ACTIVE && !enrollment.holdsSeat) {
        await this.claimSeat(tx, course, enrollment.cohortId);
        await tx.enrollment.update({ where: { id: enrollment.id }, data: { holdsSeat: true } });
      }
      if (target === EnrollmentStatus.CANCELLED || target === EnrollmentStatus.REJECTED || target === EnrollmentStatus.EXPIRED) {
        await this.releaseSeat(tx, enrollment);
      }
      await tx.enrollmentEvent.create({ data: { enrollmentId: enrollment.id, fromStatus: enrollment.status, toStatus: target, actorId, reason } });
      await this.audit.record(
        {
          action: `enrollment.${target.toLowerCase()}`,
          category: AuditCategory.ACADEMIC,
          actorId,
          resourceType: "enrollment",
          resourceId: enrollment.id,
          institutionId: enrollment.institutionId,
          metadata: { from: enrollment.status, to: target },
          meta,
        },
        tx,
      );
      if (target === EnrollmentStatus.ACTIVE && enrollment.status === EnrollmentStatus.PENDING_APPROVAL) {
        await this.notifications.notify(tx, {
          userId: enrollment.userId,
          category: NotificationCategory.ACADEMIC,
          type: NotificationType.EnrollmentActivated,
          params: { course: course.title },
          target: { kind: "course", id: course.id },
          institutionId: course.institutionId,
          requestId: meta.requestId,
        });
      }
      if (target === EnrollmentStatus.REJECTED) {
        await this.notifications.notify(tx, {
          userId: enrollment.userId,
          category: NotificationCategory.ACADEMIC,
          type: NotificationType.EnrollmentRejected,
          params: { course: course.title },
          target: { kind: "course", id: course.id },
          institutionId: course.institutionId,
          requestId: meta.requestId,
        });
      }
      return tx.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    });
  }

  async manage(actorId: string, enrollmentId: string, action: "approve" | "reject" | "suspend" | "reactivate" | "expire", reason: string | null, meta: RequestMeta) {
    const enrollment = await this.db.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!enrollment) throw notFound("Enrollment");
    await this.access.requireManage(actorId, enrollment.courseId, Permission.EnrollmentManage);
    const transitions: Record<typeof action, { from: EnrollmentStatus[]; to: EnrollmentStatus }> = {
      approve: { from: [EnrollmentStatus.PENDING_APPROVAL], to: EnrollmentStatus.ACTIVE },
      reject: { from: [EnrollmentStatus.PENDING_APPROVAL], to: EnrollmentStatus.REJECTED },
      suspend: { from: [EnrollmentStatus.ACTIVE], to: EnrollmentStatus.SUSPENDED },
      reactivate: { from: [EnrollmentStatus.SUSPENDED, EnrollmentStatus.EXPIRED], to: EnrollmentStatus.ACTIVE },
      expire: { from: [EnrollmentStatus.ACTIVE, EnrollmentStatus.SUSPENDED], to: EnrollmentStatus.EXPIRED },
    };
    const rule = transitions[action];
    if (!rule.from.includes(enrollment.status)) throw conflict(ErrorCode.BUSINESS_RULE, `Cannot ${action} an enrollment in status ${enrollment.status}`);
    return this.changeStatus(enrollment, rule.to, actorId, reason, meta);
  }

  async enrollByStaff(actorId: string, courseId: string, input: { userId: string; cohortId?: string | null }, meta: RequestMeta) {
    const course = await this.access.requireManage(actorId, courseId, Permission.EnrollmentManage);
    const user = await this.db.user.findFirst({ where: { id: input.userId, deletedAt: null }, select: { id: true } });
    if (!user) throw notFound("User");
    if (course.visibility !== CourseVisibility.PUBLIC && !(await this.access.isInstitutionMember(input.userId, course.institutionId))) {
      throw conflict(ErrorCode.BUSINESS_RULE, "The learner must be an active member of the institution");
    }
    return this.enroll(input.userId, courseId, { cohortId: input.cohortId, source: EnrollmentSource.ADMIN, bypassWindows: true, actorId }, meta);
  }

  async listForCourse(actorId: string, courseId: string, query: { page: number; pageSize: number; status?: EnrollmentStatus; search?: string }) {
    await this.access.requireManage(actorId, courseId, Permission.EnrollmentRead);
    const where: Prisma.EnrollmentWhereInput = {
      courseId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { user: { OR: [{ email: { contains: query.search.toLowerCase() } }, { displayName: { contains: query.search, mode: "insensitive" } }] } } : {}),
    };
    const [items, total] = await Promise.all([
      this.db.enrollment.findMany({
        where,
        include: { user: { select: { id: true, email: true, displayName: true } } },
        orderBy: { enrolledAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.enrollment.count({ where }),
    ]);
    return {
      data: items.map((item) => ({ ...this.present(item), user: item.user })),
      meta: offsetMetaOf(query.page, query.pageSize, total),
    };
  }

  present(enrollment: Enrollment) {
    return {
      id: enrollment.id,
      userId: enrollment.userId,
      courseId: enrollment.courseId,
      institutionId: enrollment.institutionId,
      cohortId: enrollment.cohortId,
      status: enrollment.status,
      source: enrollment.source,
      statusReason: enrollment.statusReason,
      enrolledAt: enrollment.enrolledAt,
      activatedAt: enrollment.activatedAt,
      completedAt: enrollment.completedAt,
      cancelledAt: enrollment.cancelledAt,
      expiresAt: enrollment.expiresAt,
      progressPercent: enrollment.progressPercent,
      completedLessons: enrollment.completedLessons,
      requiredLessons: enrollment.requiredLessons,
      lastActivityAt: enrollment.lastActivityAt,
      lastLessonId: enrollment.lastLessonId,
      finalScorePercent: enrollment.finalScorePercent === null ? null : Number(enrollment.finalScorePercent),
    };
  }

  async mine(userId: string, query: { cursor?: string; limit: number; status?: EnrollmentStatus }) {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.db.enrollment.findMany({
      where: { userId, ...(query.status ? { status: query.status } : {}), ...(cursor ? { id: { lt: cursor.id } } : {}) },
      include: { course: { select: { id: true, slug: true, title: true, coverFileId: true, level: true, institution: { select: { id: true, name: true } } } } },
      orderBy: { id: "desc" },
      take: query.limit + 1,
    });
    const page = buildCursorPage(rows, query.limit);
    return { data: page.data.map((row) => ({ ...this.present(row), course: row.course })), meta: page.meta };
  }

  async getVisible(actorId: string, enrollmentId: string): Promise<Enrollment> {
    const enrollment = await this.db.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!enrollment) throw notFound("Enrollment");
    if (enrollment.userId === actorId) return enrollment;
    const course = await this.access.findCourse(enrollment.courseId);
    if (await this.access.can(actorId, Permission.EnrollmentRead, course)) return enrollment;
    throw notFound("Enrollment");
  }

  async history(actorId: string, enrollmentId: string) {
    const enrollment = await this.getVisible(actorId, enrollmentId);
    return this.db.enrollmentEvent.findMany({ where: { enrollmentId: enrollment.id }, orderBy: { occurredAt: "asc" } });
  }

  async enrollInProgram(userId: string, programId: string, meta: RequestMeta) {
    const program = await this.db.program.findFirst({
      where: { id: programId, deletedAt: null, status: ContentStatus.PUBLISHED },
      include: { courses: { orderBy: { position: "asc" }, include: { course: { select: { id: true, status: true } } } } },
    });
    if (!program) throw notFound("Program");
    await this.db.programEnrollment.upsert({
      where: { userId_programId: { userId, programId } },
      create: { userId, programId, status: EnrollmentStatus.ACTIVE },
      update: { status: EnrollmentStatus.ACTIVE },
    });
    const results: Array<{ courseId: string; outcome: string }> = [];
    for (const item of program.courses) {
      if (item.course.status !== CourseStatus.PUBLISHED) {
        results.push({ courseId: item.courseId, outcome: "NOT_AVAILABLE" });
        continue;
      }
      try {
        const enrollment = await this.enroll(userId, item.courseId, { source: EnrollmentSource.PROGRAM }, meta);
        results.push({ courseId: item.courseId, outcome: enrollment.status });
      } catch (error) {
        results.push({ courseId: item.courseId, outcome: error instanceof AppError ? error.code : "FAILED" });
      }
    }
    return { programId, courses: results };
  }
}
