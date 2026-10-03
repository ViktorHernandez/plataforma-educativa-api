import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import { scopeKeyFor, type AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission, SystemRole } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import { isCheckViolation, isUniqueViolation } from "../../core/database/prisma.js";
import { assertSafeRichText } from "../../core/http/content-safety.js";
import { ErrorCode, badRequest, conflict, forbidden, notFound } from "../../core/http/errors.js";
import { offsetMetaOf } from "../../core/http/pagination.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { Prisma } from "../../generated/prisma/client.js";
import {
  AccessModel,
  CohortStatus,
  ContentStatus,
  CourseKind,
  CourseLevel,
  CourseStatus,
  CourseVisibility,
  EnrollmentPolicy,
  EnrollmentStatus,
  FilePurpose,
  FileStatus,
  MembershipStatus,
  RoleScope,
} from "../../generated/prisma/enums.js";
import type { CourseAccessService } from "./course-access.service.js";

export interface CourseInput {
  slug: string;
  title: string;
  kind?: CourseKind;
  subtitle?: string | null;
  summary?: string | null;
  description?: string | null;
  language?: string;
  level?: CourseLevel;
  visibility?: CourseVisibility;
  enrollmentPolicy?: EnrollmentPolicy;
  accessModel?: AccessModel;
  capacity?: number | null;
  enrollmentOpensAt?: Date | null;
  enrollmentClosesAt?: Date | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  estimatedMinutes?: number | null;
  certificateEnabled?: boolean;
  completionThreshold?: number;
  coverFileId?: string | null;
  categoryId?: string | null;
}

export interface CohortInput {
  name: string;
  status?: CohortStatus;
  startsAt?: Date | null;
  endsAt?: Date | null;
  enrollmentOpensAt?: Date | null;
  enrollmentClosesAt?: Date | null;
  capacity?: number | null;
  timezone?: string | null;
}

const staffRoleKeys = { INSTRUCTOR: SystemRole.CourseInstructor, ASSISTANT: SystemRole.CourseAssistant } as const;

export class CourseService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthorizationService,
    private readonly access: CourseAccessService,
    private readonly audit: AuditService,
  ) {}

  private validateWindows(input: Partial<CourseInput> | Partial<CohortInput>) {
    if (input.enrollmentOpensAt && input.enrollmentClosesAt && input.enrollmentOpensAt >= input.enrollmentClosesAt) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, "Enrollment window is invalid");
    }
    if (input.startsAt && input.endsAt && input.startsAt >= input.endsAt) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, "Course dates are invalid");
    }
  }

  private async validateReferences(institutionId: string, input: Partial<CourseInput>) {
    if (input.categoryId) {
      const category = await this.db.category.findFirst({ where: { id: input.categoryId, OR: [{ institutionId: null }, { institutionId }] } });
      if (!category) throw badRequest(ErrorCode.VALIDATION_FAILED, "Unknown category");
    }
    if (input.coverFileId) {
      const file = await this.db.file.findFirst({ where: { id: input.coverFileId, purpose: FilePurpose.COURSE_COVER, status: FileStatus.READY, deletedAt: null, institutionId } });
      if (!file) throw badRequest(ErrorCode.VALIDATION_FAILED, "Cover file is not available");
    }
  }

  async create(actorId: string, institutionId: string, input: CourseInput, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.CourseCreate, { institutionId }, { hideAs: "Institution" });
    const institution = await this.db.institution.findUnique({ where: { id: institutionId } });
    if (!institution || institution.status !== "ACTIVE") throw notFound("Institution");
    this.validateWindows(input);
    assertSafeRichText(input.description, "description");
    await this.validateReferences(institutionId, input);
    const instructorRole = await this.db.role.findFirstOrThrow({ where: { key: SystemRole.CourseInstructor, institutionId: null } });
    try {
      const course = await this.db.$transaction(async (tx) => {
        const created = await tx.course.create({
          data: {
            institutionId,
            slug: input.slug,
            title: input.title,
            kind: input.kind ?? CourseKind.COURSE,
            subtitle: input.subtitle ?? null,
            summary: input.summary ?? null,
            description: input.description ?? null,
            language: input.language ?? institution.defaultLocale,
            level: input.level ?? CourseLevel.ALL_LEVELS,
            visibility: input.visibility ?? CourseVisibility.PUBLIC,
            enrollmentPolicy: input.enrollmentPolicy ?? EnrollmentPolicy.OPEN,
            accessModel: input.accessModel ?? AccessModel.FREE,
            capacity: input.capacity ?? null,
            enrollmentOpensAt: input.enrollmentOpensAt ?? null,
            enrollmentClosesAt: input.enrollmentClosesAt ?? null,
            startsAt: input.startsAt ?? null,
            endsAt: input.endsAt ?? null,
            estimatedMinutes: input.estimatedMinutes ?? null,
            certificateEnabled: input.certificateEnabled ?? false,
            completionThreshold: input.completionThreshold ?? 100,
            coverFileId: input.coverFileId ?? null,
            categoryId: input.categoryId ?? null,
            createdById: actorId,
          },
        });
        await tx.roleAssignment.create({
          data: {
            userId: actorId,
            roleId: instructorRole.id,
            scopeType: RoleScope.COURSE,
            scopeKey: scopeKeyFor({ type: RoleScope.COURSE, courseId: created.id }),
            institutionId,
            courseId: created.id,
            grantedById: actorId,
          },
        });
        await this.audit.record({ action: "course.created", category: AuditCategory.ACADEMIC, actorId, resourceType: "course", resourceId: created.id, institutionId, meta }, tx);
        return created;
      });
      await this.authz.invalidate(actorId);
      return course;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Slug already used in this institution");
      throw error;
    }
  }

  async listForStaff(actorId: string, institutionId: string, query: { page: number; pageSize: number; status?: CourseStatus; search?: string }) {
    const canReadAll = await this.authz.can(actorId, Permission.CourseRead, { institutionId });
    const courseIds = canReadAll ? null : await this.authz.coursesWithPermission(actorId, Permission.CourseRead);
    if (courseIds && courseIds.length === 0 && !(await this.access.isInstitutionMember(actorId, institutionId))) throw notFound("Institution");
    const where: Prisma.CourseWhereInput = {
      institutionId,
      deletedAt: null,
      ...(courseIds ? { id: { in: courseIds } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { title: { contains: query.search, mode: "insensitive" } } : {}),
    };
    const [items, total] = await Promise.all([
      this.db.course.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.course.count({ where }),
    ]);
    return { data: items, meta: offsetMetaOf(query.page, query.pageSize, total) };
  }

  async getForStaff(actorId: string, courseId: string) {
    const course = await this.access.requireManage(actorId, courseId, Permission.CourseRead);
    const tags = await this.db.courseTag.findMany({ where: { courseId }, include: { tag: true } });
    const prerequisites = await this.db.coursePrerequisite.findMany({ where: { courseId }, select: { prerequisiteId: true } });
    return { ...course, tags: tags.map((item) => item.tag.label), prerequisiteIds: prerequisites.map((item) => item.prerequisiteId) };
  }

  async update(actorId: string, courseId: string, expectedVersion: number | null, input: Partial<CourseInput>, meta: RequestMeta) {
    const course = await this.access.requireManage(actorId, courseId, Permission.CourseUpdate);
    this.validateWindows({
      enrollmentOpensAt: input.enrollmentOpensAt === undefined ? course.enrollmentOpensAt : input.enrollmentOpensAt,
      enrollmentClosesAt: input.enrollmentClosesAt === undefined ? course.enrollmentClosesAt : input.enrollmentClosesAt,
      startsAt: input.startsAt === undefined ? course.startsAt : input.startsAt,
      endsAt: input.endsAt === undefined ? course.endsAt : input.endsAt,
    });
    assertSafeRichText(input.description, "description");
    await this.validateReferences(course.institutionId, input);
    if (input.capacity !== undefined && input.capacity !== null && input.capacity < course.seatsTaken) {
      throw conflict(ErrorCode.BUSINESS_RULE, "Capacity cannot be lower than the seats already taken", { seatsTaken: course.seatsTaken });
    }
    const version = expectedVersion ?? course.version;
    try {
      const result = await this.db.course.updateMany({
        where: { id: courseId, version, deletedAt: null },
        data: { ...input, version: { increment: 1 } },
      });
      if (result.count === 0) throw conflict(ErrorCode.VERSION_CONFLICT, "Course was modified by someone else", { currentVersion: (await this.access.findCourse(courseId)).version });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Slug already used in this institution");
      if (isCheckViolation(error)) throw conflict(ErrorCode.BUSINESS_RULE, "The change violates course constraints");
      throw error;
    }
    await this.audit.record({
      action: "course.updated",
      category: AuditCategory.ACADEMIC,
      actorId,
      resourceType: "course",
      resourceId: courseId,
      institutionId: course.institutionId,
      metadata: { fields: Object.keys(input) },
      meta,
    });
    return this.getForStaff(actorId, courseId);
  }

  async transition(actorId: string, courseId: string, target: CourseStatus, options: { publishLessons?: boolean }, meta: RequestMeta) {
    const permission = target === CourseStatus.PUBLISHED || target === CourseStatus.ARCHIVED ? Permission.CoursePublish : Permission.CourseUpdate;
    const course = await this.access.requireManage(actorId, courseId, permission);
    const allowed: Record<CourseStatus, CourseStatus[]> = {
      DRAFT: [CourseStatus.IN_REVIEW, CourseStatus.PUBLISHED],
      IN_REVIEW: [CourseStatus.DRAFT, CourseStatus.PUBLISHED],
      PUBLISHED: [CourseStatus.ARCHIVED, CourseStatus.DRAFT],
      ARCHIVED: [CourseStatus.DRAFT],
    };
    if (!allowed[course.status].includes(target)) throw conflict(ErrorCode.BUSINESS_RULE, `Cannot move a course from ${course.status} to ${target}`);
    if (target === CourseStatus.DRAFT && course.status === CourseStatus.PUBLISHED) {
      const learners = await this.db.enrollment.count({ where: { courseId, status: { in: [EnrollmentStatus.ACTIVE, EnrollmentStatus.PENDING_APPROVAL] } } });
      if (learners > 0) throw conflict(ErrorCode.BUSINESS_RULE, "Archive the course instead, it has active learners");
    }
    if (target === CourseStatus.PUBLISHED) {
      const lessons = await this.db.lesson.count({ where: { courseId, ...(options.publishLessons ? {} : { status: ContentStatus.PUBLISHED }) } });
      if (lessons === 0) throw conflict(ErrorCode.BUSINESS_RULE, "A course needs at least one published lesson before publishing");
    }
    await this.db.$transaction(async (tx) => {
      if (target === CourseStatus.PUBLISHED && options.publishLessons) {
        await tx.lesson.updateMany({ where: { courseId, status: ContentStatus.DRAFT }, data: { status: ContentStatus.PUBLISHED } });
      }
      await tx.course.update({
        where: { id: courseId },
        data: { status: target, version: { increment: 1 }, ...(target === CourseStatus.PUBLISHED && !course.publishedAt ? { publishedAt: new Date() } : {}) },
      });
      await this.audit.record(
        { action: `course.status.${target.toLowerCase()}`, category: AuditCategory.ACADEMIC, actorId, resourceType: "course", resourceId: courseId, institutionId: course.institutionId, meta },
        tx,
      );
    });
    return this.getForStaff(actorId, courseId);
  }

  async remove(actorId: string, courseId: string, meta: RequestMeta) {
    const course = await this.access.requireManage(actorId, courseId, Permission.CourseDelete);
    const enrollments = await this.db.enrollment.count({ where: { courseId } });
    if (enrollments > 0) throw conflict(ErrorCode.BUSINESS_RULE, "Courses with enrollments must be archived instead of deleted");
    await this.db.course.update({ where: { id: courseId }, data: { deletedAt: new Date(), slug: `${course.slug}-deleted-${Date.now()}`.slice(0, 120) } });
    await this.audit.record({ action: "course.deleted", category: AuditCategory.ACADEMIC, actorId, resourceType: "course", resourceId: courseId, institutionId: course.institutionId, meta });
  }

  async setTags(actorId: string, courseId: string, labels: string[]) {
    const course = await this.access.requireManage(actorId, courseId, Permission.CourseUpdate);
    const normalized = [...new Map(labels.map((label) => [label.trim().toLowerCase().replace(/[^a-z0-9áéíóúñü]+/gi, "-").replace(/^-|-$/g, ""), label.trim()])).entries()].filter(
      ([tagSlug]) => tagSlug.length > 0,
    );
    await this.db.$transaction(async (tx) => {
      const tagIds: string[] = [];
      for (const [tagSlug, label] of normalized) {
        const tag = await tx.tag.upsert({
          where: { institutionId_slug: { institutionId: course.institutionId, slug: tagSlug.slice(0, 60) } },
          create: { institutionId: course.institutionId, slug: tagSlug.slice(0, 60), label: label.slice(0, 80) },
          update: {},
        });
        tagIds.push(tag.id);
      }
      await tx.courseTag.deleteMany({ where: { courseId } });
      await tx.courseTag.createMany({ data: tagIds.map((tagId) => ({ courseId, tagId })), skipDuplicates: true });
    });
    return normalized.map(([, label]) => label);
  }

  async setPrerequisites(actorId: string, courseId: string, prerequisiteIds: string[], meta: RequestMeta) {
    const course = await this.access.requireManage(actorId, courseId, Permission.CourseUpdate);
    const unique = [...new Set(prerequisiteIds)];
    if (unique.includes(courseId)) throw badRequest(ErrorCode.VALIDATION_FAILED, "A course cannot require itself");
    const found = await this.db.course.findMany({
      where: { id: { in: unique }, deletedAt: null, OR: [{ institutionId: course.institutionId }, { visibility: CourseVisibility.PUBLIC }] },
      select: { id: true },
    });
    if (found.length !== unique.length) throw badRequest(ErrorCode.VALIDATION_FAILED, "Unknown prerequisite course");
    const visited = new Set<string>();
    let frontier = unique;
    while (frontier.length > 0) {
      if (frontier.includes(courseId)) throw conflict(ErrorCode.BUSINESS_RULE, "Prerequisites would create a cycle");
      frontier.forEach((id) => visited.add(id));
      const next = await this.db.coursePrerequisite.findMany({ where: { courseId: { in: frontier } }, select: { prerequisiteId: true } });
      frontier = next.map((item) => item.prerequisiteId).filter((id) => !visited.has(id));
    }
    await this.db.$transaction([
      this.db.coursePrerequisite.deleteMany({ where: { courseId } }),
      this.db.coursePrerequisite.createMany({ data: unique.map((prerequisiteId) => ({ courseId, prerequisiteId })) }),
    ]);
    await this.audit.record({ action: "course.prerequisites.updated", category: AuditCategory.ACADEMIC, actorId, resourceType: "course", resourceId: courseId, institutionId: course.institutionId, metadata: { count: unique.length }, meta });
    return unique;
  }

  async staff(actorId: string, courseId: string) {
    await this.access.requireManage(actorId, courseId, Permission.CourseRead);
    const assignments = await this.db.roleAssignment.findMany({
      where: { courseId, role: { key: { in: Object.values(staffRoleKeys) } } },
      include: { role: { select: { key: true } }, user: { select: { id: true, displayName: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
    return assignments.map((item) => ({
      assignmentId: item.id,
      userId: item.user.id,
      displayName: item.user.displayName,
      email: item.user.email,
      role: item.role.key === SystemRole.CourseInstructor ? ("INSTRUCTOR" as const) : ("ASSISTANT" as const),
      createdAt: item.createdAt,
    }));
  }

  async addStaff(actorId: string, courseId: string, input: { userId: string; role: keyof typeof staffRoleKeys }, meta: RequestMeta) {
    const course = await this.access.requireManage(actorId, courseId, Permission.CourseStaffManage);
    const membership = await this.db.institutionMembership.findUnique({ where: { institutionId_userId: { institutionId: course.institutionId, userId: input.userId } } });
    if (membership?.status !== MembershipStatus.ACTIVE) throw badRequest(ErrorCode.BUSINESS_RULE, "Staff must be active members of the institution");
    const role = await this.db.role.findFirstOrThrow({ where: { key: staffRoleKeys[input.role], institutionId: null }, include: { permissions: true } });
    for (const item of role.permissions) {
      if (!(await this.access.can(actorId, item.permission as Permission, course))) throw forbidden("You cannot grant permissions you do not hold");
    }
    try {
      const assignment = await this.db.roleAssignment.create({
        data: {
          userId: input.userId,
          roleId: role.id,
          scopeType: RoleScope.COURSE,
          scopeKey: scopeKeyFor({ type: RoleScope.COURSE, courseId }),
          institutionId: course.institutionId,
          courseId,
          grantedById: actorId,
        },
      });
      await this.audit.record({
        action: "course.staff.added",
        category: AuditCategory.ACCESS,
        actorId,
        resourceType: "course",
        resourceId: courseId,
        institutionId: course.institutionId,
        metadata: { userId: input.userId, role: input.role },
        meta,
      });
      await this.authz.invalidate(input.userId);
      return { assignmentId: assignment.id };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Already assigned");
      throw error;
    }
  }

  async removeStaff(actorId: string, courseId: string, assignmentId: string, meta: RequestMeta) {
    const course = await this.access.requireManage(actorId, courseId, Permission.CourseStaffManage);
    const assignment = await this.db.roleAssignment.findFirst({ where: { id: assignmentId, courseId } });
    if (!assignment) throw notFound("Staff assignment");
    if (assignment.userId === actorId) throw forbidden("You cannot remove yourself");
    await this.db.roleAssignment.delete({ where: { id: assignmentId } });
    await this.audit.record({ action: "course.staff.removed", category: AuditCategory.ACCESS, actorId, resourceType: "course", resourceId: courseId, institutionId: course.institutionId, metadata: { userId: assignment.userId }, meta });
    await this.authz.invalidate(assignment.userId);
  }

  async cohorts(actorId: string | null, courseId: string) {
    const course = await this.access.requireVisible(actorId, courseId);
    const staff = actorId ? await this.access.can(actorId, Permission.CourseRead, course) : false;
    return this.db.cohort.findMany({
      where: { courseId, ...(staff ? {} : { status: { in: [CohortStatus.OPEN, CohortStatus.RUNNING] } }) },
      orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }],
    });
  }

  async createCohort(actorId: string, courseId: string, input: CohortInput, meta: RequestMeta) {
    const course = await this.access.requireManage(actorId, courseId, Permission.CourseUpdate);
    this.validateWindows(input);
    const cohort = await this.db.cohort.create({
      data: {
        courseId,
        name: input.name,
        status: input.status ?? CohortStatus.PLANNED,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        enrollmentOpensAt: input.enrollmentOpensAt ?? null,
        enrollmentClosesAt: input.enrollmentClosesAt ?? null,
        capacity: input.capacity ?? null,
        timezone: input.timezone ?? null,
      },
    });
    await this.audit.record({ action: "course.cohort.created", category: AuditCategory.ACADEMIC, actorId, resourceType: "cohort", resourceId: cohort.id, institutionId: course.institutionId, meta });
    return cohort;
  }

  async updateCohort(actorId: string, courseId: string, cohortId: string, input: Partial<CohortInput>, meta: RequestMeta) {
    const course = await this.access.requireManage(actorId, courseId, Permission.CourseUpdate);
    const cohort = await this.db.cohort.findFirst({ where: { id: cohortId, courseId } });
    if (!cohort) throw notFound("Cohort");
    this.validateWindows({ ...cohort, ...input });
    if (input.capacity !== undefined && input.capacity !== null && input.capacity < cohort.seatsTaken) {
      throw conflict(ErrorCode.BUSINESS_RULE, "Capacity cannot be lower than the seats already taken");
    }
    const updated = await this.db.cohort.update({ where: { id: cohortId }, data: input });
    await this.audit.record({ action: "course.cohort.updated", category: AuditCategory.ACADEMIC, actorId, resourceType: "cohort", resourceId: cohortId, institutionId: course.institutionId, meta });
    return updated;
  }
}
