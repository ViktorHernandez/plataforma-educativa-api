import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import type { AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import { isUniqueViolation } from "../../core/database/prisma.js";
import { assertSafeRichText } from "../../core/http/content-safety.js";
import { ErrorCode, badRequest, conflict, notFound } from "../../core/http/errors.js";
import { offsetMetaOf } from "../../core/http/pagination.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import { Prisma, type QuestionBank } from "../../generated/prisma/client.js";
import type { QuestionDifficulty, QuestionType } from "../../generated/prisma/enums.js";
import { QuestionStatus } from "../../generated/prisma/enums.js";
import { validateQuestionDefinition, type OptionInput } from "./question-types.js";

export interface QuestionInput {
  type: QuestionType;
  prompt: string;
  explanation?: string | null;
  points?: number;
  difficulty?: QuestionDifficulty | null;
  categoryId?: string | null;
  status?: QuestionStatus;
  tags?: string[];
  config?: Record<string, unknown>;
  options?: OptionInput[];
}

export class QuestionBankService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  scope(bank: Pick<QuestionBank, "institutionId" | "courseId">) {
    return { institutionId: bank.institutionId, courseId: bank.courseId };
  }

  async requireBank(actorId: string, bankId: string, permission: Permission): Promise<QuestionBank> {
    const bank = await this.db.questionBank.findFirst({ where: { id: bankId, archivedAt: null } });
    if (!bank) throw notFound("Question bank");
    await this.authz.require(actorId, permission, this.scope(bank), { hideAs: "Question bank" });
    return bank;
  }

  async createBank(actorId: string, institutionId: string, input: { title: string; description?: string | null; courseId?: string | null }, meta: RequestMeta) {
    if (input.courseId) {
      const course = await this.db.course.findFirst({ where: { id: input.courseId, institutionId, deletedAt: null }, select: { id: true } });
      if (!course) throw notFound("Course");
    }
    await this.authz.require(actorId, Permission.QuestionBankManage, { institutionId, courseId: input.courseId ?? null }, { hideAs: "Institution" });
    const bank = await this.db.questionBank.create({
      data: { institutionId, courseId: input.courseId ?? null, title: input.title, description: input.description ?? null, createdById: actorId },
    });
    await this.audit.record({ action: "question_bank.created", category: AuditCategory.ACADEMIC, actorId, resourceType: "question_bank", resourceId: bank.id, institutionId, meta });
    return bank;
  }

  async listBanks(actorId: string, institutionId: string, courseId?: string) {
    const institutionWide = await this.authz.can(actorId, Permission.QuestionBankRead, { institutionId });
    const courseIds = institutionWide ? null : await this.authz.coursesWithPermission(actorId, Permission.QuestionBankRead);
    if (!institutionWide && (!courseIds || courseIds.length === 0)) throw notFound("Institution");
    return this.db.questionBank.findMany({
      where: {
        institutionId,
        archivedAt: null,
        ...(courseId ? { courseId } : {}),
        ...(courseIds ? { courseId: { in: courseIds } } : {}),
      },
      include: { _count: { select: { questions: true } } },
      orderBy: { updatedAt: "desc" },
    });
  }

  async createCategory(actorId: string, bankId: string, name: string) {
    await this.requireBank(actorId, bankId, Permission.QuestionBankManage);
    try {
      return await this.db.questionCategory.create({ data: { bankId, name } });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Category already exists");
      throw error;
    }
  }

  async categories(actorId: string, bankId: string) {
    await this.requireBank(actorId, bankId, Permission.QuestionBankRead);
    return this.db.questionCategory.findMany({ where: { bankId }, orderBy: { name: "asc" }, include: { _count: { select: { questions: true } } } });
  }

  private validate(input: QuestionInput) {
    assertSafeRichText(input.prompt, "prompt");
    assertSafeRichText(input.explanation, "explanation");
    for (const option of input.options ?? []) {
      assertSafeRichText(option.text, "options.text");
      assertSafeRichText(option.feedback, "options.feedback");
    }
    const { config, issues } = validateQuestionDefinition(input.type, input.config, input.options ?? []);
    if (issues.length > 0) throw badRequest(ErrorCode.VALIDATION_FAILED, "Invalid question definition", { issues });
    return config;
  }

  private async assertCategory(bankId: string, categoryId: string | null | undefined) {
    if (!categoryId) return;
    const category = await this.db.questionCategory.findFirst({ where: { id: categoryId, bankId } });
    if (!category) throw badRequest(ErrorCode.VALIDATION_FAILED, "Category does not belong to the bank");
  }

  async createQuestion(actorId: string, bankId: string, input: QuestionInput, meta: RequestMeta) {
    const bank = await this.requireBank(actorId, bankId, Permission.QuestionBankManage);
    const config = this.validate(input);
    await this.assertCategory(bankId, input.categoryId);
    const question = await this.db.question.create({
      data: {
        bankId,
        categoryId: input.categoryId ?? null,
        type: input.type,
        status: input.status ?? QuestionStatus.ACTIVE,
        difficulty: input.difficulty ?? null,
        prompt: input.prompt,
        explanation: input.explanation ?? null,
        points: new Prisma.Decimal(input.points ?? 1),
        config: config as Prisma.InputJsonValue,
        tags: [...new Set((input.tags ?? []).map((tag) => tag.trim().toLowerCase()))],
        createdById: actorId,
        options: { create: (input.options ?? []).map((option, index) => ({ ...option, position: index + 1, feedback: option.feedback ?? null, matchTarget: option.matchTarget ?? null })) },
      },
      include: { options: { orderBy: { position: "asc" } } },
    });
    await this.audit.record({ action: "question.created", category: AuditCategory.ACADEMIC, actorId, resourceType: "question", resourceId: question.id, institutionId: bank.institutionId, meta });
    return this.present(question);
  }

  async updateQuestion(actorId: string, questionId: string, input: QuestionInput, meta: RequestMeta) {
    const existing = await this.db.question.findUnique({ where: { id: questionId } });
    if (!existing) throw notFound("Question");
    const bank = await this.requireBank(actorId, existing.bankId, Permission.QuestionBankManage);
    const config = this.validate(input);
    await this.assertCategory(existing.bankId, input.categoryId);
    const question = await this.db.$transaction(async (tx) => {
      await tx.questionOption.deleteMany({ where: { questionId } });
      return tx.question.update({
        where: { id: questionId },
        data: {
          categoryId: input.categoryId ?? null,
          type: input.type,
          status: input.status ?? existing.status,
          difficulty: input.difficulty ?? null,
          prompt: input.prompt,
          explanation: input.explanation ?? null,
          points: new Prisma.Decimal(input.points ?? Number(existing.points)),
          config: config as Prisma.InputJsonValue,
          tags: [...new Set((input.tags ?? existing.tags).map((tag) => tag.trim().toLowerCase()))],
          version: { increment: 1 },
          options: { create: (input.options ?? []).map((option, index) => ({ ...option, position: index + 1, feedback: option.feedback ?? null, matchTarget: option.matchTarget ?? null })) },
        },
        include: { options: { orderBy: { position: "asc" } } },
      });
    });
    await this.audit.record({ action: "question.updated", category: AuditCategory.ACADEMIC, actorId, resourceType: "question", resourceId: questionId, institutionId: bank.institutionId, metadata: { version: question.version }, meta });
    return this.present(question);
  }

  async setStatus(actorId: string, questionId: string, status: QuestionStatus) {
    const existing = await this.db.question.findUnique({ where: { id: questionId } });
    if (!existing) throw notFound("Question");
    await this.requireBank(actorId, existing.bankId, Permission.QuestionBankManage);
    const question = await this.db.question.update({ where: { id: questionId }, data: { status }, include: { options: { orderBy: { position: "asc" } } } });
    return this.present(question);
  }

  async get(actorId: string, questionId: string) {
    const question = await this.db.question.findUnique({ where: { id: questionId }, include: { options: { orderBy: { position: "asc" } } } });
    if (!question) throw notFound("Question");
    await this.requireBank(actorId, question.bankId, Permission.QuestionBankRead);
    return this.present(question);
  }

  async list(
    actorId: string,
    bankId: string,
    query: { page: number; pageSize: number; categoryId?: string; type?: QuestionType; status?: QuestionStatus; difficulty?: QuestionDifficulty; tag?: string; search?: string },
  ) {
    await this.requireBank(actorId, bankId, Permission.QuestionBankRead);
    const where: Prisma.QuestionWhereInput = {
      bankId,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.difficulty ? { difficulty: query.difficulty } : {}),
      ...(query.tag ? { tags: { has: query.tag.toLowerCase() } } : {}),
      ...(query.search ? { prompt: { contains: query.search, mode: "insensitive" } } : {}),
    };
    const [items, total] = await Promise.all([
      this.db.question.findMany({ where, include: { options: { orderBy: { position: "asc" } } }, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.question.count({ where }),
    ]);
    return { data: items.map((item) => this.present(item)), meta: offsetMetaOf(query.page, query.pageSize, total) };
  }

  present(question: Prisma.QuestionGetPayload<{ include: { options: true } }>) {
    return {
      id: question.id,
      bankId: question.bankId,
      categoryId: question.categoryId,
      type: question.type,
      status: question.status,
      difficulty: question.difficulty,
      prompt: question.prompt,
      explanation: question.explanation,
      points: Number(question.points),
      config: question.config as Record<string, unknown>,
      tags: question.tags,
      version: question.version,
      options: question.options.map((option) => ({ id: option.id, position: option.position, text: option.text, isCorrect: option.isCorrect, feedback: option.feedback, matchTarget: option.matchTarget })),
      createdAt: question.createdAt,
      updatedAt: question.updatedAt,
    };
  }
}
