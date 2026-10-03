import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import type { AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import { isUniqueViolation } from "../../core/database/prisma.js";
import { ErrorCode, badRequest, conflict, notFound } from "../../core/http/errors.js";
import { offsetMetaOf } from "../../core/http/pagination.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import { resolveLocale, type SupportedLocale } from "../../core/i18n/translator.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { AccessModel, CourseLevel } from "../../generated/prisma/enums.js";
import { CohortStatus, ContentStatus, CourseStatus, CourseVisibility, EnrollmentPolicy, MembershipStatus } from "../../generated/prisma/enums.js";
import type { CourseAccessService } from "./course-access.service.js";

export interface CatalogQuery {
  page: number;
  pageSize: number;
  q?: string;
  categoryId?: string;
  institutionId?: string;
  level?: CourseLevel;
  language?: string;
  accessModel?: AccessModel;
  tag?: string;
  sort: "newest" | "title" | "startsAt";
}

const catalogSelect = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  summary: true,
  kind: true,
  level: true,
  language: true,
  accessModel: true,
  enrollmentPolicy: true,
  visibility: true,
  capacity: true,
  seatsTaken: true,
  enrollmentOpensAt: true,
  enrollmentClosesAt: true,
  startsAt: true,
  endsAt: true,
  estimatedMinutes: true,
  certificateEnabled: true,
  coverFileId: true,
  publishedAt: true,
  institution: { select: { id: true, slug: true, name: true } },
  category: { select: { id: true, slug: true, names: true } },
  tags: { select: { tag: { select: { label: true } } } },
} satisfies Prisma.CourseSelect;

type CatalogRow = Prisma.CourseGetPayload<{ select: typeof catalogSelect }>;

export function categoryName(names: unknown, locale: SupportedLocale): string {
  const record = names && typeof names === "object" ? (names as Record<string, string>) : {};
  return record[locale] ?? record["es"] ?? record["en"] ?? Object.values(record)[0] ?? "";
}

export function enrollmentOpen(course: { enrollmentPolicy: EnrollmentPolicy; enrollmentOpensAt: Date | null; enrollmentClosesAt: Date | null; capacity: number | null; seatsTaken: number }, now = new Date()): boolean {
  if (course.enrollmentPolicy === EnrollmentPolicy.CLOSED || course.enrollmentPolicy === EnrollmentPolicy.INVITE_ONLY) return false;
  if (course.enrollmentOpensAt && course.enrollmentOpensAt > now) return false;
  if (course.enrollmentClosesAt && course.enrollmentClosesAt <= now) return false;
  if (course.capacity !== null && course.seatsTaken >= course.capacity) return false;
  return true;
}

export class CatalogService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthorizationService,
    private readonly access: CourseAccessService,
    private readonly audit: AuditService,
  ) {}

  private present(row: CatalogRow, locale: SupportedLocale) {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      subtitle: row.subtitle,
      summary: row.summary,
      kind: row.kind,
      level: row.level,
      language: row.language,
      accessModel: row.accessModel,
      enrollmentPolicy: row.enrollmentPolicy,
      enrollmentOpen: enrollmentOpen(row),
      seatsAvailable: row.capacity === null ? null : Math.max(0, row.capacity - row.seatsTaken),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      estimatedMinutes: row.estimatedMinutes,
      certificateEnabled: row.certificateEnabled,
      coverFileId: row.coverFileId,
      publishedAt: row.publishedAt,
      institution: row.institution,
      category: row.category ? { id: row.category.id, slug: row.category.slug, name: categoryName(row.category.names, locale) } : null,
      tags: row.tags.map((item) => item.tag.label),
    };
  }

  async list(viewerId: string | null, query: CatalogQuery, locale: SupportedLocale) {
    const memberInstitutionIds = viewerId
      ? (await this.db.institutionMembership.findMany({ where: { userId: viewerId, status: MembershipStatus.ACTIVE }, select: { institutionId: true } })).map((item) => item.institutionId)
      : [];
    const visibility: Prisma.CourseWhereInput[] = [{ visibility: CourseVisibility.PUBLIC }];
    if (memberInstitutionIds.length > 0) visibility.push({ visibility: CourseVisibility.INSTITUTION, institutionId: { in: memberInstitutionIds } });
    const where: Prisma.CourseWhereInput = {
      deletedAt: null,
      status: CourseStatus.PUBLISHED,
      institution: { status: "ACTIVE" },
      OR: visibility,
      ...(query.q ? { AND: [{ OR: [{ title: { contains: query.q, mode: "insensitive" } }, { summary: { contains: query.q, mode: "insensitive" } }] }] } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.institutionId ? { institutionId: query.institutionId } : {}),
      ...(query.level ? { level: query.level } : {}),
      ...(query.language ? { language: query.language } : {}),
      ...(query.accessModel ? { accessModel: query.accessModel } : {}),
      ...(query.tag ? { tags: { some: { tag: { slug: query.tag.toLowerCase() } } } } : {}),
    };
    const orderBy: Prisma.CourseOrderByWithRelationInput[] =
      query.sort === "title" ? [{ title: "asc" }, { id: "asc" }] : query.sort === "startsAt" ? [{ startsAt: { sort: "asc", nulls: "last" } }, { id: "asc" }] : [{ publishedAt: "desc" }, { id: "desc" }];
    const [rows, total] = await Promise.all([
      this.db.course.findMany({ where, select: catalogSelect, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.course.count({ where }),
    ]);
    return { data: rows.map((row) => this.present(row, locale)), meta: offsetMetaOf(query.page, query.pageSize, total) };
  }

  async detail(viewerId: string | null, courseId: string, locale: SupportedLocale) {
    const course = await this.access.requireVisible(viewerId, courseId);
    const [row, prerequisites, cohorts, instructors, enrollment, lessonStats] = await Promise.all([
      this.db.course.findUniqueOrThrow({ where: { id: course.id }, select: { ...catalogSelect, description: true } }),
      this.db.coursePrerequisite.findMany({ where: { courseId }, include: { prerequisite: { select: { id: true, title: true, slug: true } } } }),
      this.db.cohort.findMany({ where: { courseId, status: { in: [CohortStatus.OPEN, CohortStatus.RUNNING] } }, orderBy: { startsAt: "asc" } }),
      this.db.roleAssignment.findMany({
        where: { courseId, role: { key: "course_instructor" } },
        select: { user: { select: { id: true, displayName: true, profile: { select: { headline: true, avatarFileId: true } } } } },
        take: 10,
      }),
      viewerId ? this.db.enrollment.findUnique({ where: { userId_courseId: { userId: viewerId, courseId } }, select: { id: true, status: true, progressPercent: true } }) : Promise.resolve(null),
      this.db.lesson.groupBy({ by: ["type"], where: { courseId, status: ContentStatus.PUBLISHED }, _count: { _all: true } }),
    ]);
    return {
      ...this.present(row, locale),
      description: row.description,
      prerequisites: prerequisites.map((item) => item.prerequisite),
      cohorts: cohorts.map((cohort) => ({
        id: cohort.id,
        name: cohort.name,
        status: cohort.status,
        startsAt: cohort.startsAt,
        endsAt: cohort.endsAt,
        seatsAvailable: cohort.capacity === null ? null : Math.max(0, cohort.capacity - cohort.seatsTaken),
      })),
      instructors: instructors.map((item) => ({ id: item.user.id, displayName: item.user.displayName, headline: item.user.profile?.headline ?? null, avatarFileId: item.user.profile?.avatarFileId ?? null })),
      contentSummary: lessonStats.map((item) => ({ type: item.type, count: item._count._all })),
      viewerEnrollment: enrollment,
    };
  }

  async categories(institutionId: string | undefined, localeHint: string) {
    const locale = resolveLocale(localeHint);
    const categories = await this.db.category.findMany({
      where: institutionId ? { OR: [{ institutionId: null }, { institutionId }] } : { institutionId: null },
      orderBy: [{ position: "asc" }, { slug: "asc" }],
    });
    return categories.map((category) => ({ id: category.id, slug: category.slug, name: categoryName(category.names, locale), names: category.names as Record<string, string>, parentId: category.parentId, institutionId: category.institutionId }));
  }

  async createCategory(actorId: string, input: { slug: string; names: Record<string, string>; parentId?: string | null; institutionId?: string | null; position?: number }, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.CategoryManage, { institutionId: input.institutionId ?? null });
    if (input.parentId) {
      const parent = await this.db.category.findUnique({ where: { id: input.parentId } });
      if (!parent || (parent.institutionId && parent.institutionId !== input.institutionId)) throw badRequest(ErrorCode.VALIDATION_FAILED, "Unknown parent category");
    }
    try {
      const category = await this.db.category.create({
        data: { slug: input.slug, names: input.names, parentId: input.parentId ?? null, institutionId: input.institutionId ?? null, position: input.position ?? 0 },
      });
      await this.audit.record({ action: "category.created", category: AuditCategory.ACADEMIC, actorId, resourceType: "category", resourceId: category.id, institutionId: input.institutionId ?? null, meta });
      return category;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Category slug already exists");
      throw error;
    }
  }

  async programs(viewerId: string | null, query: { page: number; pageSize: number; institutionId?: string }) {
    const memberInstitutionIds = viewerId
      ? (await this.db.institutionMembership.findMany({ where: { userId: viewerId, status: MembershipStatus.ACTIVE }, select: { institutionId: true } })).map((item) => item.institutionId)
      : [];
    const where: Prisma.ProgramWhereInput = {
      status: ContentStatus.PUBLISHED,
      deletedAt: null,
      ...(query.institutionId ? { institutionId: query.institutionId } : {}),
      OR: [
        { institution: { isPlatform: true } },
        { institutionId: { in: memberInstitutionIds } },
        { courses: { some: { course: { visibility: CourseVisibility.PUBLIC, status: CourseStatus.PUBLISHED } } } },
      ],
    };
    const [rows, total] = await Promise.all([
      this.db.program.findMany({
        where,
        include: { institution: { select: { id: true, slug: true, name: true } }, _count: { select: { courses: true } } },
        orderBy: { publishedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.program.count({ where }),
    ]);
    return {
      data: rows.map((program) => ({
        id: program.id,
        slug: program.slug,
        kind: program.kind,
        title: program.title,
        summary: program.summary,
        level: program.level,
        estimatedHours: program.estimatedHours,
        institution: program.institution,
        courseCount: program._count.courses,
        publishedAt: program.publishedAt,
      })),
      meta: offsetMetaOf(query.page, query.pageSize, total),
    };
  }

  async program(viewerId: string | null, programId: string) {
    const program = await this.db.program.findFirst({
      where: { id: programId, deletedAt: null },
      include: {
        institution: { select: { id: true, slug: true, name: true } },
        courses: { orderBy: { position: "asc" }, include: { course: { select: { id: true, slug: true, title: true, level: true, estimatedMinutes: true, status: true, visibility: true } } } },
      },
    });
    if (!program) throw notFound("Program");
    const staff = viewerId ? await this.authz.can(viewerId, Permission.ProgramRead, { institutionId: program.institutionId }) : false;
    if (program.status !== ContentStatus.PUBLISHED && !staff) throw notFound("Program");
    return {
      id: program.id,
      slug: program.slug,
      kind: program.kind,
      title: program.title,
      summary: program.summary,
      description: program.description,
      status: program.status,
      level: program.level,
      estimatedHours: program.estimatedHours,
      institution: program.institution,
      courses: program.courses
        .filter((item) => staff || item.course.status === CourseStatus.PUBLISHED)
        .map((item) => ({ position: item.position, isRequired: item.isRequired, ...item.course })),
    };
  }
}
