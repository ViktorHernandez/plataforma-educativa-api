import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import type { AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import { isUniqueViolation } from "../../core/database/prisma.js";
import { assertSafeRichText } from "../../core/http/content-safety.js";
import { ErrorCode, badRequest, conflict, notFound } from "../../core/http/errors.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import { ContentStatus, CourseLevel, ProgramKind } from "../../generated/prisma/enums.js";

export interface ProgramInput {
  slug: string;
  title: string;
  kind?: ProgramKind;
  summary?: string | null;
  description?: string | null;
  level?: CourseLevel;
  estimatedHours?: number | null;
}

export class ProgramService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  private async requireProgram(actorId: string, programId: string, permission: Permission) {
    const program = await this.db.program.findFirst({ where: { id: programId, deletedAt: null } });
    if (!program) throw notFound("Program");
    await this.authz.require(actorId, permission, { institutionId: program.institutionId }, { hideAs: "Program" });
    return program;
  }

  async create(actorId: string, institutionId: string, input: ProgramInput, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.ProgramCreate, { institutionId }, { hideAs: "Institution" });
    assertSafeRichText(input.description, "description");
    try {
      const program = await this.db.program.create({
        data: {
          institutionId,
          slug: input.slug,
          title: input.title,
          kind: input.kind ?? ProgramKind.PROGRAM,
          summary: input.summary ?? null,
          description: input.description ?? null,
          level: input.level ?? CourseLevel.ALL_LEVELS,
          estimatedHours: input.estimatedHours ?? null,
          createdById: actorId,
        },
      });
      await this.audit.record({ action: "program.created", category: AuditCategory.ACADEMIC, actorId, resourceType: "program", resourceId: program.id, institutionId, meta });
      return program;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Program slug already exists");
      throw error;
    }
  }

  async update(actorId: string, programId: string, input: Partial<ProgramInput> & { status?: ContentStatus }, meta: RequestMeta) {
    const program = await this.requireProgram(actorId, programId, Permission.ProgramUpdate);
    assertSafeRichText(input.description, "description");
    if (input.status === ContentStatus.PUBLISHED) {
      const courses = await this.db.programCourse.count({ where: { programId } });
      if (courses === 0) throw conflict(ErrorCode.BUSINESS_RULE, "A program needs at least one course before publishing");
    }
    try {
      const updated = await this.db.program.update({
        where: { id: programId },
        data: { ...input, ...(input.status === ContentStatus.PUBLISHED && !program.publishedAt ? { publishedAt: new Date() } : {}) },
      });
      await this.audit.record({ action: "program.updated", category: AuditCategory.ACADEMIC, actorId, resourceType: "program", resourceId: programId, institutionId: program.institutionId, metadata: { fields: Object.keys(input) }, meta });
      return updated;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Program slug already exists");
      throw error;
    }
  }

  async setCourses(actorId: string, programId: string, items: Array<{ courseId: string; isRequired: boolean }>, meta: RequestMeta) {
    const program = await this.requireProgram(actorId, programId, Permission.ProgramUpdate);
    const ids = items.map((item) => item.courseId);
    if (new Set(ids).size !== ids.length) throw badRequest(ErrorCode.VALIDATION_FAILED, "Duplicated course");
    const found = await this.db.course.count({ where: { id: { in: ids }, institutionId: program.institutionId, deletedAt: null } });
    if (found !== ids.length) throw badRequest(ErrorCode.VALIDATION_FAILED, "Every course must belong to the program institution");
    await this.db.$transaction([
      this.db.programCourse.deleteMany({ where: { programId } }),
      this.db.programCourse.createMany({ data: items.map((item, index) => ({ programId, courseId: item.courseId, isRequired: item.isRequired, position: index + 1 })) }),
    ]);
    await this.audit.record({ action: "program.courses.updated", category: AuditCategory.ACADEMIC, actorId, resourceType: "program", resourceId: programId, institutionId: program.institutionId, metadata: { count: items.length }, meta });
  }

  async listForInstitution(actorId: string, institutionId: string) {
    await this.authz.require(actorId, Permission.ProgramRead, { institutionId }, { hideAs: "Institution" });
    return this.db.program.findMany({ where: { institutionId, deletedAt: null }, orderBy: { updatedAt: "desc" }, include: { _count: { select: { courses: true } } } });
  }
}
