import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import { assertSafeRichText } from "../../core/http/content-safety.js";
import { AppError, ErrorCode, badRequest, conflict, notFound } from "../../core/http/errors.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import { Prisma, type Assessment } from "../../generated/prisma/client.js";
import type {
  AssessmentType,
  QuestionDifficulty,
  ScoringPolicy} from "../../generated/prisma/enums.js";
import {
  AssessmentItemKind,
  AssessmentStatus,
  AttemptStatus,
  QuestionStatus,
  RevealPolicy
} from "../../generated/prisma/enums.js";
import type { CourseAccessService } from "../courses/course-access.service.js";

export interface AssessmentInput {
  title: string;
  instructions?: string | null;
  type?: AssessmentType;
  opensAt?: Date | null;
  closesAt?: Date | null;
  timeLimitSeconds?: number | null;
  gracePeriodSeconds?: number;
  maxAttempts?: number | null;
  scoringPolicy?: ScoringPolicy;
  passingScorePercent?: number | null;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  feedbackPolicy?: RevealPolicy;
  revealAnswersPolicy?: RevealPolicy;
  weight?: number;
}

export interface AssessmentItemInput {
  kind: AssessmentItemKind;
  questionId?: string;
  bankId?: string;
  categoryId?: string | null;
  difficulty?: QuestionDifficulty | null;
  drawCount?: number;
  pointsOverride?: number | null;
}

export function assessmentWindowState(assessment: Pick<Assessment, "status" | "opensAt" | "closesAt">, now = new Date()): "DRAFT" | "UPCOMING" | "OPEN" | "CLOSED" {
  if (assessment.status === AssessmentStatus.DRAFT) return "DRAFT";
  if (assessment.status !== AssessmentStatus.PUBLISHED) return "CLOSED";
  if (assessment.opensAt && assessment.opensAt > now) return "UPCOMING";
  if (assessment.closesAt && assessment.closesAt <= now) return "CLOSED";
  return "OPEN";
}

export class AssessmentService {
  constructor(
    private readonly db: Database,
    private readonly access: CourseAccessService,
    private readonly audit: AuditService,
  ) {}

  async find(assessmentId: string): Promise<Assessment> {
    const assessment = await this.db.assessment.findFirst({ where: { id: assessmentId, deletedAt: null } });
    if (!assessment) throw notFound("Assessment");
    return assessment;
  }

  async requireManage(actorId: string, assessmentId: string, permission: Permission = Permission.AssessmentManage) {
    const assessment = await this.find(assessmentId);
    await this.access.requireManage(actorId, assessment.courseId, permission);
    return assessment;
  }

  private toData(input: Partial<AssessmentInput>) {
    if (input.opensAt && input.closesAt && input.opensAt >= input.closesAt) throw badRequest(ErrorCode.VALIDATION_FAILED, "opensAt must be before closesAt");
    assertSafeRichText(input.instructions, "instructions");
    const { passingScorePercent, weight, ...rest } = input;
    return {
      ...rest,
      ...(passingScorePercent !== undefined ? { passingScorePercent: passingScorePercent === null ? null : new Prisma.Decimal(passingScorePercent) } : {}),
      ...(weight !== undefined ? { weight: new Prisma.Decimal(weight) } : {}),
    };
  }

  async create(actorId: string, courseId: string, input: AssessmentInput, meta: RequestMeta) {
    const course = await this.access.requireManage(actorId, courseId, Permission.AssessmentManage);
    const assessment = await this.db.assessment.create({
      data: { courseId, institutionId: course.institutionId, createdById: actorId, ...this.toData(input), title: input.title },
    });
    await this.audit.record({ action: "assessment.created", category: AuditCategory.ACADEMIC, actorId, resourceType: "assessment", resourceId: assessment.id, institutionId: course.institutionId, meta });
    return assessment;
  }

  async update(actorId: string, assessmentId: string, input: Partial<AssessmentInput>, meta: RequestMeta) {
    const assessment = await this.requireManage(actorId, assessmentId);
    const attempts = await this.db.assessmentAttempt.count({ where: { assessmentId } });
    const structural: Array<keyof AssessmentInput> = ["shuffleQuestions", "shuffleOptions", "scoringPolicy"];
    if (attempts > 0 && structural.some((field) => input[field] !== undefined)) {
      throw conflict(ErrorCode.BUSINESS_RULE, "Scoring and shuffling cannot change once learners have attempts");
    }
    const data = this.toData({
      ...input,
      opensAt: input.opensAt === undefined ? assessment.opensAt : input.opensAt,
      closesAt: input.closesAt === undefined ? assessment.closesAt : input.closesAt,
    });
    const updated = await this.db.assessment.update({ where: { id: assessmentId }, data: { ...data, version: { increment: 1 } } });
    await this.audit.record({
      action: "assessment.updated",
      category: AuditCategory.ACADEMIC,
      actorId,
      resourceType: "assessment",
      resourceId: assessmentId,
      institutionId: assessment.institutionId,
      metadata: { fields: Object.keys(input) },
      meta,
    });
    return updated;
  }

  async setItems(actorId: string, assessmentId: string, items: AssessmentItemInput[], meta: RequestMeta) {
    const assessment = await this.requireManage(actorId, assessmentId);
    if ((await this.db.assessmentAttempt.count({ where: { assessmentId } })) > 0) throw conflict(ErrorCode.BUSINESS_RULE, "Items cannot change once learners have attempts");
    for (const [index, item] of items.entries()) {
      if (item.kind === AssessmentItemKind.FIXED) {
        if (!item.questionId) throw badRequest(ErrorCode.VALIDATION_FAILED, `Item ${index + 1} requires questionId`);
        const question = await this.db.question.findFirst({ where: { id: item.questionId, status: QuestionStatus.ACTIVE, bank: { institutionId: assessment.institutionId, archivedAt: null } } });
        if (!question) throw badRequest(ErrorCode.VALIDATION_FAILED, `Item ${index + 1} references an unavailable question`);
      } else {
        if (!item.bankId) throw badRequest(ErrorCode.VALIDATION_FAILED, `Item ${index + 1} requires bankId`);
        const bank = await this.db.questionBank.findFirst({ where: { id: item.bankId, institutionId: assessment.institutionId, archivedAt: null } });
        if (!bank) throw badRequest(ErrorCode.VALIDATION_FAILED, `Item ${index + 1} references an unavailable bank`);
        const available = await this.db.question.count({
          where: { bankId: item.bankId, status: QuestionStatus.ACTIVE, ...(item.categoryId ? { categoryId: item.categoryId } : {}), ...(item.difficulty ? { difficulty: item.difficulty } : {}) },
        });
        if (available < (item.drawCount ?? 1)) throw badRequest(ErrorCode.VALIDATION_FAILED, `Item ${index + 1} needs ${item.drawCount ?? 1} questions but the pool has ${available}`);
      }
    }
    await this.db.$transaction([
      this.db.assessmentItem.deleteMany({ where: { assessmentId } }),
      this.db.assessmentItem.createMany({
        data: items.map((item, index) => ({
          assessmentId,
          position: index + 1,
          kind: item.kind,
          questionId: item.kind === AssessmentItemKind.FIXED ? item.questionId! : null,
          bankId: item.kind === AssessmentItemKind.POOL ? item.bankId! : null,
          categoryId: item.kind === AssessmentItemKind.POOL ? (item.categoryId ?? null) : null,
          difficulty: item.kind === AssessmentItemKind.POOL ? (item.difficulty ?? null) : null,
          drawCount: item.kind === AssessmentItemKind.POOL ? (item.drawCount ?? 1) : 1,
          pointsOverride: item.pointsOverride === undefined || item.pointsOverride === null ? null : new Prisma.Decimal(item.pointsOverride),
        })),
      }),
      this.db.assessment.update({ where: { id: assessmentId }, data: { version: { increment: 1 } } }),
    ]);
    await this.audit.record({ action: "assessment.items.updated", category: AuditCategory.ACADEMIC, actorId, resourceType: "assessment", resourceId: assessmentId, institutionId: assessment.institutionId, metadata: { count: items.length }, meta });
    return this.items(assessmentId);
  }

  async items(assessmentId: string) {
    const items = await this.db.assessmentItem.findMany({ where: { assessmentId }, orderBy: { position: "asc" } });
    return items.map((item) => ({
      id: item.id,
      position: item.position,
      kind: item.kind,
      questionId: item.questionId,
      bankId: item.bankId,
      categoryId: item.categoryId,
      difficulty: item.difficulty,
      drawCount: item.drawCount,
      pointsOverride: item.pointsOverride === null ? null : Number(item.pointsOverride),
    }));
  }

  async setStatus(actorId: string, assessmentId: string, status: AssessmentStatus, meta: RequestMeta) {
    const assessment = await this.requireManage(actorId, assessmentId);
    if (status === AssessmentStatus.PUBLISHED) {
      const items = await this.db.assessmentItem.count({ where: { assessmentId } });
      if (items === 0) throw conflict(ErrorCode.BUSINESS_RULE, "Add at least one item before publishing");
    }
    if (status === AssessmentStatus.DRAFT && (await this.db.assessmentAttempt.count({ where: { assessmentId } })) > 0) {
      throw conflict(ErrorCode.BUSINESS_RULE, "Assessments with attempts cannot go back to draft");
    }
    const updated = await this.db.assessment.update({
      where: { id: assessmentId },
      data: { status, version: { increment: 1 }, ...(status === AssessmentStatus.PUBLISHED && !assessment.publishedAt ? { publishedAt: new Date() } : {}) },
    });
    await this.audit.record({ action: `assessment.status.${status.toLowerCase()}`, category: AuditCategory.ACADEMIC, actorId, resourceType: "assessment", resourceId: assessmentId, institutionId: assessment.institutionId, meta });
    return updated;
  }

  async listForCourse(actorId: string, courseId: string) {
    const course = await this.access.findCourse(courseId);
    const staff = await this.access.can(actorId, Permission.AssessmentRead, course);
    if (!staff && !(await this.access.learnerEnrollment(actorId, courseId))) throw notFound("Course");
    return this.db.assessment.findMany({
      where: { courseId, deletedAt: null, ...(staff ? {} : { status: { in: [AssessmentStatus.PUBLISHED, AssessmentStatus.CLOSED] } }) },
      orderBy: [{ opensAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    });
  }

  async learnerView(userId: string, assessmentId: string) {
    const assessment = await this.find(assessmentId);
    const course = await this.access.findCourse(assessment.courseId);
    const staff = await this.access.can(userId, Permission.AssessmentRead, course);
    const enrollment = await this.access.learnerEnrollment(userId, assessment.courseId);
    if (!staff && (!enrollment || assessment.status === AssessmentStatus.DRAFT || assessment.status === AssessmentStatus.ARCHIVED)) throw notFound("Assessment");
    const [attempts, result, questionCount] = await Promise.all([
      this.db.assessmentAttempt.findMany({ where: { assessmentId, userId }, orderBy: { attemptNumber: "asc" }, select: { id: true, attemptNumber: true, status: true, startedAt: true, submittedAt: true, scorePercent: true } }),
      this.db.assessmentResult.findUnique({ where: { assessmentId_userId: { assessmentId, userId } } }),
      this.db.assessmentItem.aggregate({ where: { assessmentId }, _sum: { drawCount: true } }),
    ]);
    const used = attempts.filter((attempt) => attempt.status !== AttemptStatus.VOIDED).length;
    const scoreVisible = assessment.feedbackPolicy === RevealPolicy.AFTER_SUBMISSION || (assessment.feedbackPolicy === RevealPolicy.AFTER_CLOSE && assessmentWindowState(assessment) === "CLOSED");
    return {
      id: assessment.id,
      courseId: assessment.courseId,
      title: assessment.title,
      instructions: assessment.instructions,
      type: assessment.type,
      availability: assessmentWindowState(assessment),
      opensAt: assessment.opensAt,
      closesAt: assessment.closesAt,
      timeLimitSeconds: assessment.timeLimitSeconds,
      maxAttempts: assessment.maxAttempts,
      attemptsUsed: used,
      attemptsRemaining: assessment.maxAttempts === null ? null : Math.max(0, assessment.maxAttempts - used),
      questionCount: questionCount._sum.drawCount ?? 0,
      passingScorePercent: assessment.passingScorePercent === null ? null : Number(assessment.passingScorePercent),
      scoringPolicy: assessment.scoringPolicy,
      inProgressAttemptId: attempts.find((attempt) => attempt.status === AttemptStatus.IN_PROGRESS)?.id ?? null,
      result: result && scoreVisible ? { scorePercent: result.scorePercent === null ? null : Number(result.scorePercent), passed: result.passed, attemptsCount: result.attemptsCount } : null,
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt,
        scorePercent: scoreVisible && attempt.scorePercent !== null ? Number(attempt.scorePercent) : null,
      })),
    };
  }

  async statistics(actorId: string, assessmentId: string) {
    const assessment = await this.requireManage(actorId, assessmentId, Permission.AssessmentRead);
    const [attempts, perQuestion, distribution] = await Promise.all([
      this.db.assessmentAttempt.groupBy({ by: ["status"], where: { assessmentId }, _count: { _all: true }, _avg: { scorePercent: true } }),
      this.db.$queryRaw<Array<{ questionId: string; answered: bigint; correct: bigint; avgPoints: number | null; maxPoints: number | null }>>`
        SELECT aq."questionId" AS "questionId",
               COUNT(aa."id") AS "answered",
               COUNT(*) FILTER (WHERE aa."isCorrect" = true) AS "correct",
               AVG(aa."awardedPoints")::float AS "avgPoints",
               MAX(aq."points")::float AS "maxPoints"
        FROM "attempt_questions" aq
        JOIN "assessment_attempts" at ON at."id" = aq."attemptId"
        LEFT JOIN "attempt_answers" aa ON aa."attemptQuestionId" = aq."id"
        WHERE at."assessmentId" = ${assessmentId}::uuid AND at."status" = 'GRADED'
        GROUP BY aq."questionId"`,
      this.db.$queryRaw<Array<{ bucket: number; count: bigint }>>`
        SELECT LEAST(FLOOR(COALESCE("scorePercent", 0) / 10), 9)::int AS "bucket", COUNT(*) AS "count"
        FROM "assessment_attempts"
        WHERE "assessmentId" = ${assessmentId}::uuid AND "status" = 'GRADED'
        GROUP BY 1 ORDER BY 1`,
    ]);
    const graded = attempts.find((item) => item.status === AttemptStatus.GRADED);
    const passing = assessment.passingScorePercent === null ? null : Number(assessment.passingScorePercent);
    const passed = passing === null ? null : await this.db.assessmentAttempt.count({ where: { assessmentId, status: AttemptStatus.GRADED, passed: true } });
    const gradedCount = graded?._count._all ?? 0;
    return {
      assessmentId,
      attemptsByStatus: attempts.map((item) => ({ status: item.status, count: item._count._all })),
      gradedAttempts: gradedCount,
      averageScorePercent: graded?._avg.scorePercent === null || graded?._avg.scorePercent === undefined ? null : Math.round(Number(graded._avg.scorePercent) * 100) / 100,
      passRate: passed === null || gradedCount === 0 ? null : Math.round((passed / gradedCount) * 10_000) / 100,
      scoreDistribution: Array.from({ length: 10 }, (_, bucket) => ({
        fromPercent: bucket * 10,
        toPercent: bucket === 9 ? 100 : bucket * 10 + 9.99,
        count: Number(distribution.find((row) => row.bucket === bucket)?.count ?? 0),
      })),
      questions: perQuestion.map((row) => ({
        questionId: row.questionId,
        answered: Number(row.answered),
        correctRate: Number(row.answered) === 0 ? null : Math.round((Number(row.correct) / Number(row.answered)) * 10_000) / 100,
        averagePoints: row.avgPoints === null ? null : Math.round(row.avgPoints * 100) / 100,
        maxPoints: row.maxPoints,
      })),
    };
  }

  assertAvailable(assessment: Assessment): void {
    if (assessmentWindowState(assessment) !== "OPEN") throw new AppError(409, ErrorCode.ASSESSMENT_NOT_AVAILABLE, "Assessment is not open");
  }
}
