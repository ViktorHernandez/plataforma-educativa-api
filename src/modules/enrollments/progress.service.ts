import { Permission } from "../../core/authz/permissions.js";
import type { Database, Tx } from "../../core/database/prisma.js";
import { AppError, ErrorCode, conflict, notFound } from "../../core/http/errors.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { RateLimitService } from "../../core/security/rate-limiter.js";
import { ContentStatus, EnrollmentStatus, LessonType, NotificationCategory, ProgressStatus, SectionType } from "../../generated/prisma/enums.js";
import type { CourseAccessService } from "../courses/course-access.service.js";
import { NotificationType } from "../notifications/notification-catalog.js";
import type { NotificationService } from "../notifications/notification.service.js";
import type { CertificateService } from "./certificate.service.js";

const MAX_HEARTBEAT_DELTA_SECONDS = 300;
const VIDEO_COMPLETION_PERCENT = 90;

export interface HeartbeatInput {
  positionSeconds?: number;
  progressPercent?: number;
  timeSpentDeltaSeconds?: number;
}

function percent(done: number, total: number): number {
  if (total === 0) return 0;
  return Math.min(100, Math.floor((done / total) * 100));
}

export class ProgressService {
  constructor(
    private readonly db: Database,
    private readonly access: CourseAccessService,
    private readonly certificates: CertificateService,
    private readonly notifications: NotificationService,
    private readonly rateLimits: RateLimitService,
  ) {}

  private async learnerContext(userId: string, lessonId: string) {
    const context = await this.access.requireLessonAccess(userId, lessonId);
    if (!context.enrollmentId) throw new AppError(403, ErrorCode.NOT_ENROLLED, "Progress is tracked only for enrolled learners");
    const enrollment = await this.db.enrollment.findUniqueOrThrow({ where: { id: context.enrollmentId } });
    if (enrollment.status !== EnrollmentStatus.ACTIVE && enrollment.status !== EnrollmentStatus.COMPLETED) {
      throw new AppError(403, ErrorCode.NOT_ENROLLED, "Enrollment is not active");
    }
    return { ...context, enrollment };
  }

  async heartbeat(userId: string, lessonId: string, input: HeartbeatInput, meta: RequestMeta) {
    await this.rateLimits.consume("progressUser", userId);
    const { lesson, enrollment } = await this.learnerContext(userId, lessonId);
    const now = new Date();
    const delta = Math.min(MAX_HEARTBEAT_DELTA_SECONDS, Math.max(0, Math.floor(input.timeSpentDeltaSeconds ?? 0)));
    const existing = await this.db.lessonProgress.findUnique({ where: { enrollmentId_lessonId: { enrollmentId: enrollment.id, lessonId } } });
    const reported = input.progressPercent === undefined ? (existing?.progressPercent ?? 0) : Math.round(input.progressPercent);
    const progressPercent = Math.max(existing?.progressPercent ?? 0, Math.min(100, reported));
    const progress = await this.db.lessonProgress.upsert({
      where: { enrollmentId_lessonId: { enrollmentId: enrollment.id, lessonId } },
      create: {
        enrollmentId: enrollment.id,
        userId,
        courseId: lesson.courseId,
        lessonId,
        status: ProgressStatus.IN_PROGRESS,
        progressPercent,
        positionSeconds: input.positionSeconds ?? null,
        timeSpentSeconds: delta,
      },
      update: {
        progressPercent,
        positionSeconds: input.positionSeconds ?? undefined,
        timeSpentSeconds: { increment: delta },
        lastViewedAt: now,
      },
    });
    await this.db.enrollment.update({ where: { id: enrollment.id }, data: { lastActivityAt: now, lastLessonId: lessonId } });
    if (lesson.type === LessonType.VIDEO && progressPercent >= VIDEO_COMPLETION_PERCENT && progress.status !== ProgressStatus.COMPLETED) {
      return this.complete(userId, lessonId, meta, { automatic: true });
    }
    return this.presentLesson(progress);
  }

  async complete(userId: string, lessonId: string, meta: RequestMeta, options: { automatic?: boolean; fromAssessment?: boolean } = {}) {
    const { lesson, enrollment } = await this.learnerContext(userId, lessonId);
    if (lesson.type === LessonType.ASSESSMENT && !options.fromAssessment) {
      throw conflict(ErrorCode.BUSINESS_RULE, "Assessment lessons are completed by passing the assessment");
    }
    const now = new Date();
    const result = await this.db.$transaction(async (tx) => {
      const progress = await tx.lessonProgress.upsert({
        where: { enrollmentId_lessonId: { enrollmentId: enrollment.id, lessonId } },
        create: {
          enrollmentId: enrollment.id,
          userId,
          courseId: lesson.courseId,
          lessonId,
          status: ProgressStatus.COMPLETED,
          progressPercent: 100,
          completedAt: now,
        },
        update: { status: ProgressStatus.COMPLETED, progressPercent: 100, completedAt: now, lastViewedAt: now },
      });
      await tx.activityEvent.create({ data: { userId, courseId: lesson.courseId, lessonId, enrollmentId: enrollment.id, verb: "lesson.completed", data: { automatic: options.automatic ?? false } } });
      await tx.enrollment.update({ where: { id: enrollment.id }, data: { lastActivityAt: now, lastLessonId: lessonId } });
      await this.recompute(tx, enrollment.id, meta.requestId);
      return progress;
    });
    return this.presentLesson(result);
  }

  async reopenAssessmentLesson(userId: string, courseId: string, lessonId: string, requestId: string | null): Promise<boolean> {
    const enrollment = await this.db.enrollment.findUnique({ where: { userId_courseId: { userId, courseId } } });
    if (enrollment?.status !== EnrollmentStatus.ACTIVE) return false;
    return this.db.$transaction(async (tx) => {
      const reopened = await tx.lessonProgress.updateMany({
        where: { enrollmentId: enrollment.id, lessonId, status: ProgressStatus.COMPLETED },
        data: { status: ProgressStatus.IN_PROGRESS, completedAt: null, progressPercent: 0 },
      });
      if (reopened.count === 0) return false;
      await tx.activityEvent.create({ data: { userId, courseId, lessonId, enrollmentId: enrollment.id, verb: "lesson.reopened", data: { reason: "assessment_result_changed" } } });
      await this.recompute(tx, enrollment.id, requestId);
      return true;
    });
  }

  async recompute(tx: Tx, enrollmentId: string, requestId: string | null): Promise<void> {
    const enrollment = await tx.enrollment.findUniqueOrThrow({ where: { id: enrollmentId }, include: { course: { select: { title: true, completionThreshold: true } } } });
    const required = await tx.lesson.findMany({
      where: { courseId: enrollment.courseId, isRequired: true, status: ContentStatus.PUBLISHED },
      select: { id: true, moduleId: true, unitId: true },
    });
    const completed = new Set(
      (
        await tx.lessonProgress.findMany({
          where: { enrollmentId, status: ProgressStatus.COMPLETED, lessonId: { in: required.map((lesson) => lesson.id) } },
          select: { lessonId: true },
        })
      ).map((item) => item.lessonId),
    );
    const sections = new Map<string, { type: SectionType; id: string; total: number; done: number }>();
    for (const lesson of required) {
      for (const [type, id] of [
        [SectionType.MODULE, lesson.moduleId],
        [SectionType.UNIT, lesson.unitId],
      ] as const) {
        const key = `${type}:${id}`;
        const entry = sections.get(key) ?? { type, id, total: 0, done: 0 };
        entry.total += 1;
        if (completed.has(lesson.id)) entry.done += 1;
        sections.set(key, entry);
      }
    }
    for (const section of sections.values()) {
      const sectionPercent = percent(section.done, section.total);
      await tx.sectionProgress.upsert({
        where: { enrollmentId_sectionType_sectionId: { enrollmentId, sectionType: section.type, sectionId: section.id } },
        create: {
          enrollmentId,
          sectionType: section.type,
          sectionId: section.id,
          completedLessons: section.done,
          requiredLessons: section.total,
          progressPercent: sectionPercent,
          completedAt: sectionPercent === 100 ? new Date() : null,
        },
        update: { completedLessons: section.done, requiredLessons: section.total, progressPercent: sectionPercent, completedAt: sectionPercent === 100 ? new Date() : null },
      });
    }
    const coursePercent = percent(completed.size, required.length);
    await tx.enrollment.update({ where: { id: enrollmentId }, data: { progressPercent: coursePercent, completedLessons: completed.size, requiredLessons: required.length } });
    if (enrollment.status === EnrollmentStatus.ACTIVE && required.length > 0 && coursePercent >= enrollment.course.completionThreshold) {
      const transitioned = await tx.enrollment.updateMany({
        where: { id: enrollmentId, status: EnrollmentStatus.ACTIVE },
        data: { status: EnrollmentStatus.COMPLETED, completedAt: new Date(), version: { increment: 1 } },
      });
      if (transitioned.count === 1) {
        await tx.enrollmentEvent.create({ data: { enrollmentId, fromStatus: EnrollmentStatus.ACTIVE, toStatus: EnrollmentStatus.COMPLETED, actorId: enrollment.userId } });
        await tx.activityEvent.create({ data: { userId: enrollment.userId, courseId: enrollment.courseId, enrollmentId, verb: "course.completed" } });
        await this.notifications.notify(tx, {
          userId: enrollment.userId,
          category: NotificationCategory.ACADEMIC,
          type: NotificationType.CourseCompleted,
          params: { course: enrollment.course.title },
          target: { kind: "course", id: enrollment.courseId },
          institutionId: enrollment.institutionId,
          requestId,
        });
        await this.certificates.issueForEnrollment(tx, enrollmentId, requestId);
      }
    }
  }

  private presentLesson(progress: { lessonId: string; status: ProgressStatus; progressPercent: number; positionSeconds: number | null; timeSpentSeconds: number; firstViewedAt: Date; lastViewedAt: Date; completedAt: Date | null }) {
    return {
      lessonId: progress.lessonId,
      status: progress.status,
      progressPercent: progress.progressPercent,
      positionSeconds: progress.positionSeconds,
      timeSpentSeconds: progress.timeSpentSeconds,
      firstViewedAt: progress.firstViewedAt,
      lastViewedAt: progress.lastViewedAt,
      completedAt: progress.completedAt,
    };
  }

  async enrollmentProgress(actorId: string, enrollmentId: string) {
    const enrollment = await this.db.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!enrollment) throw notFound("Enrollment");
    if (enrollment.userId !== actorId) {
      const course = await this.access.findCourse(enrollment.courseId);
      if (!(await this.access.can(actorId, Permission.ProgressRead, course))) throw notFound("Enrollment");
    }
    const [modules, lessonProgress, sections] = await Promise.all([
      this.db.courseModule.findMany({
        where: { courseId: enrollment.courseId },
        orderBy: { position: "asc" },
        include: {
          units: {
            orderBy: { position: "asc" },
            include: { lessons: { where: { status: ContentStatus.PUBLISHED }, orderBy: { position: "asc" }, select: { id: true, title: true, type: true, isRequired: true } } },
          },
        },
      }),
      this.db.lessonProgress.findMany({ where: { enrollmentId } }),
      this.db.sectionProgress.findMany({ where: { enrollmentId } }),
    ]);
    const byLesson = new Map(lessonProgress.map((item) => [item.lessonId, item]));
    const bySection = new Map(sections.map((item) => [`${item.sectionType}:${item.sectionId}`, item]));
    let nextLessonId: string | null = null;
    const outline = modules.map((module) => ({
      id: module.id,
      title: module.title,
      progressPercent: bySection.get(`MODULE:${module.id}`)?.progressPercent ?? 0,
      units: module.units.map((unit) => ({
        id: unit.id,
        title: unit.title,
        progressPercent: bySection.get(`UNIT:${unit.id}`)?.progressPercent ?? 0,
        lessons: unit.lessons.map((lesson) => {
          const progress = byLesson.get(lesson.id);
          const status = progress?.status ?? ProgressStatus.NOT_STARTED;
          if (!nextLessonId && lesson.isRequired && status !== ProgressStatus.COMPLETED) nextLessonId = lesson.id;
          return {
            id: lesson.id,
            title: lesson.title,
            type: lesson.type,
            isRequired: lesson.isRequired,
            status,
            progressPercent: progress?.progressPercent ?? 0,
            positionSeconds: progress?.positionSeconds ?? null,
            timeSpentSeconds: progress?.timeSpentSeconds ?? 0,
            completedAt: progress?.completedAt ?? null,
          };
        }),
      })),
    }));
    return {
      enrollmentId,
      courseId: enrollment.courseId,
      status: enrollment.status,
      progressPercent: enrollment.progressPercent,
      completedLessons: enrollment.completedLessons,
      requiredLessons: enrollment.requiredLessons,
      totalTimeSpentSeconds: lessonProgress.reduce((sum, item) => sum + item.timeSpentSeconds, 0),
      lastActivityAt: enrollment.lastActivityAt,
      resumeLessonId: enrollment.lastLessonId ?? nextLessonId,
      nextLessonId,
      modules: outline,
    };
  }
}
