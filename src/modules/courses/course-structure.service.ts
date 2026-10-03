import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database, Tx } from "../../core/database/prisma.js";
import { assertSafeRichText } from "../../core/http/content-safety.js";
import { ErrorCode, badRequest, conflict, notFound } from "../../core/http/errors.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import { ContentStatus, FilePurpose, FileStatus, LessonType, ResourceKind } from "../../generated/prisma/enums.js";
import type { CourseAccessService } from "./course-access.service.js";

export interface SectionInput {
  title: string;
  summary?: string | null;
  position?: number;
}

export interface LessonInput {
  title: string;
  type: LessonType;
  status?: ContentStatus;
  isRequired?: boolean;
  isPreview?: boolean;
  estimatedMinutes?: number | null;
  durationSeconds?: number | null;
  body?: string | null;
  contentUrl?: string | null;
  mediaFileId?: string | null;
  assessmentId?: string | null;
  position?: number;
}

export interface ResourceInput {
  kind: ResourceKind;
  title: string;
  description?: string | null;
  fileId?: string | null;
  url?: string | null;
}

export class CourseStructureService {
  constructor(
    private readonly db: Database,
    private readonly access: CourseAccessService,
    private readonly audit: AuditService,
  ) {}

  private async nextPosition(tx: Tx, kind: "module" | "unit" | "lesson", parentId: string): Promise<number> {
    if (kind === "module") return (await tx.courseModule.count({ where: { courseId: parentId } })) + 1;
    if (kind === "unit") return (await tx.courseUnit.count({ where: { moduleId: parentId } })) + 1;
    return (await tx.lesson.count({ where: { unitId: parentId } })) + 1;
  }

  private async touchCourse(tx: Tx, courseId: string) {
    await tx.course.update({ where: { id: courseId }, data: { version: { increment: 1 } } });
  }

  async outline(viewerId: string | null, courseId: string) {
    const course = await this.access.requireVisible(viewerId, courseId);
    const staff = viewerId ? await this.access.can(viewerId, Permission.CourseRead, course) : false;
    const modules = await this.db.courseModule.findMany({
      where: { courseId },
      orderBy: { position: "asc" },
      include: {
        units: {
          orderBy: { position: "asc" },
          include: {
            lessons: {
              where: staff ? {} : { status: ContentStatus.PUBLISHED },
              orderBy: { position: "asc" },
              select: { id: true, title: true, type: true, status: true, position: true, isRequired: true, isPreview: true, estimatedMinutes: true, durationSeconds: true, assessmentId: true },
            },
          },
        },
      },
    });
    return {
      courseId,
      staffView: staff,
      modules: modules.map((module) => ({
        id: module.id,
        title: module.title,
        summary: module.summary,
        position: module.position,
        units: module.units.map((unit) => ({ id: unit.id, title: unit.title, summary: unit.summary, position: unit.position, lessons: unit.lessons })),
      })),
    };
  }

  async createModule(actorId: string, courseId: string, input: SectionInput, meta: RequestMeta) {
    const course = await this.access.requireManage(actorId, courseId, Permission.CourseUpdate);
    return this.db.$transaction(async (tx) => {
      const created = await tx.courseModule.create({
        data: { courseId, title: input.title, summary: input.summary ?? null, position: input.position ?? (await this.nextPosition(tx, "module", courseId)) },
      });
      await this.touchCourse(tx, courseId);
      await this.audit.record({ action: "course.module.created", category: AuditCategory.ACADEMIC, actorId, resourceType: "module", resourceId: created.id, institutionId: course.institutionId, meta }, tx);
      return created;
    });
  }

  async updateModule(actorId: string, moduleId: string, input: Partial<SectionInput>) {
    const module = await this.db.courseModule.findUnique({ where: { id: moduleId } });
    if (!module) throw notFound("Module");
    await this.access.requireManage(actorId, module.courseId, Permission.CourseUpdate);
    return this.db.$transaction(async (tx) => {
      const updated = await tx.courseModule.update({ where: { id: moduleId }, data: input });
      await this.touchCourse(tx, module.courseId);
      return updated;
    });
  }

  async deleteModule(actorId: string, moduleId: string, meta: RequestMeta) {
    const module = await this.db.courseModule.findUnique({ where: { id: moduleId } });
    if (!module) throw notFound("Module");
    const course = await this.access.requireManage(actorId, module.courseId, Permission.CourseUpdate);
    await this.assertNoLearnerProgress({ moduleId });
    await this.db.$transaction(async (tx) => {
      await tx.courseModule.delete({ where: { id: moduleId } });
      await this.touchCourse(tx, module.courseId);
      await this.audit.record({ action: "course.module.deleted", category: AuditCategory.ACADEMIC, actorId, resourceType: "module", resourceId: moduleId, institutionId: course.institutionId, meta }, tx);
    });
  }

  async createUnit(actorId: string, moduleId: string, input: SectionInput) {
    const module = await this.db.courseModule.findUnique({ where: { id: moduleId } });
    if (!module) throw notFound("Module");
    await this.access.requireManage(actorId, module.courseId, Permission.CourseUpdate);
    return this.db.$transaction(async (tx) => {
      const created = await tx.courseUnit.create({
        data: { moduleId, courseId: module.courseId, title: input.title, summary: input.summary ?? null, position: input.position ?? (await this.nextPosition(tx, "unit", moduleId)) },
      });
      await this.touchCourse(tx, module.courseId);
      return created;
    });
  }

  async updateUnit(actorId: string, unitId: string, input: Partial<SectionInput>) {
    const unit = await this.db.courseUnit.findUnique({ where: { id: unitId } });
    if (!unit) throw notFound("Unit");
    await this.access.requireManage(actorId, unit.courseId, Permission.CourseUpdate);
    return this.db.$transaction(async (tx) => {
      const updated = await tx.courseUnit.update({ where: { id: unitId }, data: input });
      await this.touchCourse(tx, unit.courseId);
      return updated;
    });
  }

  async deleteUnit(actorId: string, unitId: string) {
    const unit = await this.db.courseUnit.findUnique({ where: { id: unitId } });
    if (!unit) throw notFound("Unit");
    await this.access.requireManage(actorId, unit.courseId, Permission.CourseUpdate);
    await this.assertNoLearnerProgress({ unitId });
    await this.db.$transaction(async (tx) => {
      await tx.courseUnit.delete({ where: { id: unitId } });
      await this.touchCourse(tx, unit.courseId);
    });
  }

  private async validateLesson(courseId: string, institutionId: string, input: Partial<LessonInput>) {
    assertSafeRichText(input.body, "body");
    if (input.contentUrl && !input.contentUrl.startsWith("https://")) throw badRequest(ErrorCode.VALIDATION_FAILED, "Only https content URLs are allowed");
    if (input.mediaFileId) {
      const file = await this.db.file.findFirst({ where: { id: input.mediaFileId, institutionId, purpose: FilePurpose.LESSON_MEDIA, status: FileStatus.READY, deletedAt: null } });
      if (!file) throw badRequest(ErrorCode.VALIDATION_FAILED, "Media file is not available");
    }
    if (input.assessmentId) {
      const assessment = await this.db.assessment.findFirst({ where: { id: input.assessmentId, courseId, deletedAt: null } });
      if (!assessment) throw badRequest(ErrorCode.VALIDATION_FAILED, "Assessment does not belong to this course");
    }
    if (input.type === LessonType.ASSESSMENT && input.assessmentId === undefined) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, "Assessment lessons require an assessmentId");
    }
  }

  async createLesson(actorId: string, unitId: string, input: LessonInput, meta: RequestMeta) {
    const unit = await this.db.courseUnit.findUnique({ where: { id: unitId } });
    if (!unit) throw notFound("Unit");
    const course = await this.access.requireManage(actorId, unit.courseId, Permission.CourseUpdate);
    await this.validateLesson(course.id, course.institutionId, input);
    try {
      return await this.db.$transaction(async (tx) => {
        const lesson = await tx.lesson.create({
          data: {
            unitId,
            moduleId: unit.moduleId,
            courseId: unit.courseId,
            title: input.title,
            type: input.type,
            status: input.status ?? ContentStatus.DRAFT,
            isRequired: input.isRequired ?? true,
            isPreview: input.isPreview ?? false,
            estimatedMinutes: input.estimatedMinutes ?? null,
            durationSeconds: input.durationSeconds ?? null,
            body: input.body ?? null,
            contentUrl: input.contentUrl ?? null,
            mediaFileId: input.mediaFileId ?? null,
            assessmentId: input.assessmentId ?? null,
            position: input.position ?? (await this.nextPosition(tx, "lesson", unitId)),
          },
        });
        await this.touchCourse(tx, unit.courseId);
        await this.audit.record({ action: "course.lesson.created", category: AuditCategory.ACADEMIC, actorId, resourceType: "lesson", resourceId: lesson.id, institutionId: course.institutionId, meta }, tx);
        return lesson;
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("assessmentId")) throw conflict(ErrorCode.CONFLICT, "The assessment is already linked to another lesson");
      throw error;
    }
  }

  async updateLesson(actorId: string, lessonId: string, input: Partial<LessonInput>, meta: RequestMeta) {
    const lesson = await this.db.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson) throw notFound("Lesson");
    const course = await this.access.requireManage(actorId, lesson.courseId, Permission.CourseUpdate);
    await this.validateLesson(course.id, course.institutionId, { ...input, type: input.type ?? lesson.type, assessmentId: input.assessmentId === undefined ? lesson.assessmentId : input.assessmentId });
    return this.db.$transaction(async (tx) => {
      const updated = await tx.lesson.update({ where: { id: lessonId }, data: input });
      await this.touchCourse(tx, lesson.courseId);
      await this.audit.record({ action: "course.lesson.updated", category: AuditCategory.ACADEMIC, actorId, resourceType: "lesson", resourceId: lessonId, institutionId: course.institutionId, metadata: { fields: Object.keys(input) }, meta }, tx);
      return updated;
    });
  }

  async deleteLesson(actorId: string, lessonId: string, meta: RequestMeta) {
    const lesson = await this.db.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson) throw notFound("Lesson");
    const course = await this.access.requireManage(actorId, lesson.courseId, Permission.CourseUpdate);
    await this.assertNoLearnerProgress({ lessonId });
    await this.db.$transaction(async (tx) => {
      await tx.lesson.delete({ where: { id: lessonId } });
      await this.touchCourse(tx, lesson.courseId);
      await this.audit.record({ action: "course.lesson.deleted", category: AuditCategory.ACADEMIC, actorId, resourceType: "lesson", resourceId: lessonId, institutionId: course.institutionId, meta }, tx);
    });
  }

  private async assertNoLearnerProgress(filter: { moduleId?: string; unitId?: string; lessonId?: string }) {
    const count = await this.db.lessonProgress.count({
      where: { lesson: { ...(filter.moduleId ? { moduleId: filter.moduleId } : {}), ...(filter.unitId ? { unitId: filter.unitId } : {}), ...(filter.lessonId ? { id: filter.lessonId } : {}) } },
    });
    if (count > 0) throw conflict(ErrorCode.BUSINESS_RULE, "Content with learner progress cannot be deleted, unpublish it instead");
  }

  async reorder(actorId: string, level: "modules" | "units" | "lessons", parentId: string, orderedIds: string[]) {
    const unique = [...new Set(orderedIds)];
    if (unique.length !== orderedIds.length) throw badRequest(ErrorCode.VALIDATION_FAILED, "Duplicated ids");
    let courseId: string;
    let currentIds: string[];
    if (level === "modules") {
      courseId = parentId;
      currentIds = (await this.db.courseModule.findMany({ where: { courseId }, select: { id: true } })).map((item) => item.id);
    } else if (level === "units") {
      const module = await this.db.courseModule.findUnique({ where: { id: parentId } });
      if (!module) throw notFound("Module");
      courseId = module.courseId;
      currentIds = (await this.db.courseUnit.findMany({ where: { moduleId: parentId }, select: { id: true } })).map((item) => item.id);
    } else {
      const unit = await this.db.courseUnit.findUnique({ where: { id: parentId } });
      if (!unit) throw notFound("Unit");
      courseId = unit.courseId;
      currentIds = (await this.db.lesson.findMany({ where: { unitId: parentId }, select: { id: true } })).map((item) => item.id);
    }
    await this.access.requireManage(actorId, courseId, Permission.CourseUpdate);
    if (currentIds.length !== unique.length || !currentIds.every((id) => unique.includes(id))) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, "The list must contain exactly the current children");
    }
    await this.db.$transaction(async (tx) => {
      for (const [index, id] of unique.entries()) {
        if (level === "modules") await tx.courseModule.update({ where: { id }, data: { position: index + 1 } });
        else if (level === "units") await tx.courseUnit.update({ where: { id }, data: { position: index + 1 } });
        else await tx.lesson.update({ where: { id }, data: { position: index + 1 } });
      }
      await this.touchCourse(tx, courseId);
    });
  }

  async lessonContent(viewerId: string | null, lessonId: string) {
    const { lesson, staff, enrollmentId } = await this.access.requireLessonAccess(viewerId, lessonId);
    const [resources, tracks, progress] = await Promise.all([
      this.db.lessonResource.findMany({ where: { lessonId }, orderBy: { position: "asc" } }),
      lesson.mediaFileId
        ? this.db.mediaTrack.findMany({ where: { mediaFileId: lesson.mediaFileId }, select: { id: true, kind: true, language: true, label: true, isDefault: true, trackFileId: true } })
        : Promise.resolve([]),
      enrollmentId ? this.db.lessonProgress.findUnique({ where: { enrollmentId_lessonId: { enrollmentId, lessonId } } }) : Promise.resolve(null),
    ]);
    return {
      id: lesson.id,
      courseId: lesson.courseId,
      moduleId: lesson.moduleId,
      unitId: lesson.unitId,
      title: lesson.title,
      type: lesson.type,
      status: lesson.status,
      isRequired: lesson.isRequired,
      isPreview: lesson.isPreview,
      estimatedMinutes: lesson.estimatedMinutes,
      durationSeconds: lesson.durationSeconds,
      body: lesson.body,
      contentUrl: lesson.contentUrl,
      mediaFileId: lesson.mediaFileId,
      assessmentId: lesson.assessmentId,
      staffView: staff,
      resources: resources.map((resource) => ({ id: resource.id, kind: resource.kind, title: resource.title, description: resource.description, fileId: resource.fileId, url: resource.url, position: resource.position })),
      mediaTracks: tracks,
      progress: progress ? { status: progress.status, progressPercent: progress.progressPercent, positionSeconds: progress.positionSeconds, completedAt: progress.completedAt } : null,
    };
  }

  async addResource(actorId: string, lessonId: string, input: ResourceInput) {
    const lesson = await this.db.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson) throw notFound("Lesson");
    const course = await this.access.requireManage(actorId, lesson.courseId, Permission.CourseUpdate);
    if (input.kind === ResourceKind.FILE) {
      if (!input.fileId) throw badRequest(ErrorCode.VALIDATION_FAILED, "fileId is required");
      const file = await this.db.file.findFirst({ where: { id: input.fileId, institutionId: course.institutionId, purpose: FilePurpose.LESSON_RESOURCE, status: FileStatus.READY, deletedAt: null } });
      if (!file) throw badRequest(ErrorCode.VALIDATION_FAILED, "File is not available");
    } else if (!input.url || !input.url.startsWith("https://")) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, "An https url is required");
    }
    const position = (await this.db.lessonResource.count({ where: { lessonId } })) + 1;
    return this.db.lessonResource.create({
      data: {
        lessonId,
        position,
        kind: input.kind,
        title: input.title,
        description: input.description ?? null,
        fileId: input.kind === ResourceKind.FILE ? input.fileId! : null,
        url: input.kind === ResourceKind.LINK ? input.url! : null,
      },
    });
  }

  async removeResource(actorId: string, resourceId: string) {
    const resource = await this.db.lessonResource.findUnique({ where: { id: resourceId }, include: { lesson: { select: { courseId: true } } } });
    if (!resource) throw notFound("Resource");
    await this.access.requireManage(actorId, resource.lesson.courseId, Permission.CourseUpdate);
    await this.db.lessonResource.delete({ where: { id: resourceId } });
  }

  async addMediaTrack(actorId: string, lessonId: string, input: { trackFileId: string; kind: "CAPTIONS" | "SUBTITLES" | "DESCRIPTIONS" | "CHAPTERS" | "TRANSCRIPT"; language: string; label: string; isDefault?: boolean }) {
    const lesson = await this.db.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson || !lesson.mediaFileId) throw notFound("Lesson media");
    const course = await this.access.requireManage(actorId, lesson.courseId, Permission.CourseUpdate);
    const trackFile = await this.db.file.findFirst({ where: { id: input.trackFileId, institutionId: course.institutionId, purpose: FilePurpose.CAPTION, status: FileStatus.READY, deletedAt: null } });
    if (!trackFile) throw badRequest(ErrorCode.VALIDATION_FAILED, "Track file is not available");
    return this.db.mediaTrack.upsert({
      where: { mediaFileId_kind_language: { mediaFileId: lesson.mediaFileId, kind: input.kind, language: input.language } },
      create: { mediaFileId: lesson.mediaFileId, trackFileId: input.trackFileId, kind: input.kind, language: input.language, label: input.label, isDefault: input.isDefault ?? false },
      update: { trackFileId: input.trackFileId, label: input.label, isDefault: input.isDefault ?? false },
    });
  }
}
