import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import { Permission } from "../../core/authz/permissions.js";
import { randomSeed } from "../../core/crypto/random.js";
import type { Database, Tx } from "../../core/database/prisma.js";
import { isUniqueViolation } from "../../core/database/prisma.js";
import type { OutboxService } from "../../core/events/outbox.js";
import { AppError, ErrorCode, badRequest, conflict, notFound } from "../../core/http/errors.js";
import { offsetMetaOf } from "../../core/http/pagination.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { RateLimitService } from "../../core/security/rate-limiter.js";
import { Prisma, type Assessment, type AssessmentAttempt } from "../../generated/prisma/client.js";
import { AssessmentItemKind, AttemptStatus, GradingMode, NotificationCategory, QuestionStatus, QuestionType, RevealPolicy } from "../../generated/prisma/enums.js";
import type { CourseAccessService } from "../courses/course-access.service.js";
import type { ProgressService } from "../enrollments/progress.service.js";
import { NotificationType } from "../notifications/notification-catalog.js";
import type { NotificationService } from "../notifications/notification.service.js";
import { assessmentWindowState, type AssessmentService } from "./assessment.service.js";
import { buildSnapshot, sample, shuffle, validateResponseShape, type QuestionSnapshot, type SourceQuestion } from "./attempt-builder.js";
import { aggregateScore, gradeResponse, roundPoints, type AnswerKey } from "./grading.js";
import type { AnswerResponse } from "./question-types.js";

export const ATTEMPT_AUTOSUBMIT_EVENT = "assessment.attempt.autosubmit";

type QuestionWithOptions = Prisma.QuestionGetPayload<{ include: { options: true } }>;

function toSource(question: QuestionWithOptions): SourceQuestion {
  return {
    id: question.id,
    version: question.version,
    type: question.type,
    prompt: question.prompt,
    explanation: question.explanation,
    points: Number(question.points),
    config: (question.config ?? {}) as Record<string, unknown>,
    options: question.options,
  };
}

export function attemptDeadline(assessment: Pick<Assessment, "timeLimitSeconds" | "closesAt">, startedAt: Date, extraTimeSeconds: number): Date | null {
  const limitDeadline = assessment.timeLimitSeconds ? new Date(startedAt.getTime() + (assessment.timeLimitSeconds + extraTimeSeconds) * 1000) : null;
  return [limitDeadline, assessment.closesAt].filter((value): value is Date => value !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

export interface RecalculatedResult {
  attemptsCount: number;
  gradedAttempts: number;
  scorePercent: number | null;
  passed: boolean | null;
  lastAttemptId: string | null;
}

function isVisible(policy: RevealPolicy, assessment: Assessment): boolean {
  if (policy === RevealPolicy.NEVER) return false;
  if (policy === RevealPolicy.AFTER_SUBMISSION) return true;
  return assessmentWindowState(assessment) === "CLOSED";
}

export class AttemptService {
  constructor(
    private readonly db: Database,
    private readonly access: CourseAccessService,
    private readonly assessments: AssessmentService,
    private readonly progress: ProgressService,
    private readonly notifications: NotificationService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
  ) {}

  private async ownedAttempt(userId: string, attemptId: string) {
    const attempt = await this.db.assessmentAttempt.findFirst({ where: { id: attemptId, userId } });
    if (!attempt) throw notFound("Attempt");
    return attempt;
  }

  private async lockAttempt(tx: Tx, attemptId: string): Promise<AttemptStatus | null> {
    const rows = await tx.$queryRaw<Array<{ status: AttemptStatus }>>`SELECT "status" FROM "assessment_attempts" WHERE "id" = ${attemptId}::uuid FOR UPDATE`;
    return rows[0]?.status ?? null;
  }

  private graceDeadline(attempt: AssessmentAttempt, assessment: Assessment): Date | null {
    return attempt.deadlineAt ? new Date(attempt.deadlineAt.getTime() + assessment.gracePeriodSeconds * 1000) : null;
  }

  private async drawQuestions(assessment: Assessment): Promise<Array<{ question: QuestionWithOptions; points: number }>> {
    const items = await this.db.assessmentItem.findMany({ where: { assessmentId: assessment.id }, orderBy: { position: "asc" } });
    const chosen: Array<{ question: QuestionWithOptions; points: number }> = [];
    const used = new Set<string>();
    for (const item of items) {
      if (item.kind === AssessmentItemKind.FIXED && item.questionId) {
        const question = await this.db.question.findFirst({ where: { id: item.questionId, status: QuestionStatus.ACTIVE }, include: { options: true } });
        if (!question || used.has(question.id)) continue;
        used.add(question.id);
        chosen.push({ question, points: item.pointsOverride === null ? Number(question.points) : Number(item.pointsOverride) });
        continue;
      }
      const pool = await this.db.question.findMany({
        where: {
          bankId: item.bankId!,
          status: QuestionStatus.ACTIVE,
          id: { notIn: [...used] },
          ...(item.categoryId ? { categoryId: item.categoryId } : {}),
          ...(item.difficulty ? { difficulty: item.difficulty } : {}),
        },
        include: { options: true },
        take: 500,
      });
      for (const question of sample(pool, item.drawCount)) {
        used.add(question.id);
        chosen.push({ question, points: item.pointsOverride === null ? Number(question.points) : Number(item.pointsOverride) });
      }
    }
    if (chosen.length === 0) throw new AppError(409, ErrorCode.ASSESSMENT_NOT_AVAILABLE, "Assessment has no available questions");
    return assessment.shuffleQuestions ? shuffle(chosen) : chosen;
  }

  async start(userId: string, assessmentId: string, meta: RequestMeta) {
    await this.rateLimits.consume("writeUser", userId);
    const assessment = await this.assessments.find(assessmentId);
    const enrollment = await this.access.learnerEnrollment(userId, assessment.courseId);
    if (!enrollment) throw new AppError(403, ErrorCode.NOT_ENROLLED, "Active enrollment required");
    this.assessments.assertAvailable(assessment);

    const open = await this.db.assessmentAttempt.findFirst({ where: { assessmentId, userId, status: AttemptStatus.IN_PROGRESS } });
    if (open) {
      const graceDeadline = this.graceDeadline(open, assessment);
      if (!graceDeadline || graceDeadline > new Date()) return this.view(open.id, userId);
      await this.finalize(open.id, { automatic: true }, meta);
    }
    const used = await this.db.assessmentAttempt.count({ where: { assessmentId, userId, status: { not: AttemptStatus.VOIDED } } });
    if (assessment.maxAttempts !== null && used >= assessment.maxAttempts) throw new AppError(409, ErrorCode.ATTEMPTS_EXHAUSTED, "No attempts left");
    const lastNumber = await this.db.assessmentAttempt.aggregate({ where: { assessmentId, userId }, _max: { attemptNumber: true } });
    const attemptNumber = (lastNumber._max.attemptNumber ?? 0) + 1;
    const accommodation = await this.db.assessmentAccommodation.findUnique({ where: { assessmentId_userId: { assessmentId, userId } } });
    const extraTimeSeconds = accommodation && !accommodation.revokedAt && assessment.timeLimitSeconds ? accommodation.extraTimeSeconds : 0;

    const drawn = await this.drawQuestions(assessment);
    const now = new Date();
    const deadlineAt = attemptDeadline(assessment, now, extraTimeSeconds);
    const built = drawn.map((entry, index) => ({ ...buildSnapshot(toSource(entry.question), { shuffleOptions: assessment.shuffleOptions, points: entry.points }), entry, position: index + 1 }));
    const maxPoints = roundPoints(built.reduce((sum, item) => sum + item.entry.points, 0));

    try {
      const attempt = await this.db.$transaction(async (tx) => {
        const created = await tx.assessmentAttempt.create({
          data: {
            assessmentId,
            userId,
            enrollmentId: enrollment.id,
            attemptNumber,
            seed: randomSeed(),
            deadlineAt,
            extraTimeSeconds,
            maxPoints: new Prisma.Decimal(maxPoints),
            ipAddress: meta.ip,
          },
        });
        await tx.attemptQuestion.createMany({
          data: built.map((item) => ({
            attemptId: created.id,
            questionId: item.entry.question.id,
            questionVersion: item.entry.question.version,
            position: item.position,
            type: item.entry.question.type,
            points: new Prisma.Decimal(item.entry.points),
            snapshot: item.snapshot as unknown as Prisma.InputJsonValue,
            answerKey: item.answerKey as unknown as Prisma.InputJsonValue,
          })),
        });
        if (deadlineAt) {
          await this.outbox.enqueue(tx, {
            type: ATTEMPT_AUTOSUBMIT_EVENT,
            aggregateType: "attempt",
            aggregateId: created.id,
            payload: { attemptId: created.id },
            availableAt: new Date(deadlineAt.getTime() + assessment.gracePeriodSeconds * 1000 + 1000),
            requestId: meta.requestId,
          });
        }
        await tx.activityEvent.create({ data: { userId, courseId: assessment.courseId, enrollmentId: enrollment.id, verb: "assessment.attempt.started", data: { assessmentId, attemptId: created.id } } });
        return created;
      });
      await this.audit.record({
        action: "assessment.attempt.started",
        category: AuditCategory.ACADEMIC,
        actorId: userId,
        resourceType: "attempt",
        resourceId: attempt.id,
        institutionId: assessment.institutionId,
        metadata: { assessmentId, attemptNumber: attempt.attemptNumber, extraTimeSeconds },
        meta,
      });
      return this.view(attempt.id, userId);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrent = await this.db.assessmentAttempt.findFirst({ where: { assessmentId, userId, status: AttemptStatus.IN_PROGRESS } });
        if (concurrent) return this.view(concurrent.id, userId);
        throw conflict(ErrorCode.CONFLICT, "Another attempt was started concurrently, retry");
      }
      throw error;
    }
  }

  async view(attemptId: string, userId: string) {
    const attempt = await this.ownedAttempt(userId, attemptId);
    const assessment = await this.assessments.find(attempt.assessmentId);
    if (attempt.status === AttemptStatus.IN_PROGRESS) {
      const graceDeadline = this.graceDeadline(attempt, assessment);
      if (graceDeadline && graceDeadline <= new Date()) {
        await this.finalize(attempt.id, { automatic: true }, { ip: null, userAgent: null, requestId: null });
      }
    }
    const current = await this.db.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    const questions = await this.db.attemptQuestion.findMany({ where: { attemptId }, orderBy: { position: "asc" }, include: { answer: { select: { response: true, savedAt: true } } } });
    return {
      id: current.id,
      assessmentId: current.assessmentId,
      attemptNumber: current.attemptNumber,
      status: current.status,
      startedAt: current.startedAt,
      deadlineAt: current.deadlineAt,
      submittedAt: current.submittedAt,
      serverTime: new Date(),
      questions: questions.map((question) => {
        const snapshot = question.snapshot as unknown as QuestionSnapshot;
        return {
          id: question.id,
          position: question.position,
          type: question.type,
          prompt: snapshot.prompt,
          points: Number(question.points),
          options: snapshot.options ?? null,
          items: snapshot.items ?? null,
          targets: snapshot.targets ?? null,
          minWords: snapshot.minWords ?? null,
          maxWords: snapshot.maxWords ?? null,
          savedResponse: (question.answer?.response ?? null) as Record<string, unknown> | null,
          savedAt: question.answer?.savedAt ?? null,
        };
      }),
    };
  }

  async saveAnswer(userId: string, attemptId: string, attemptQuestionId: string, response: AnswerResponse, meta: RequestMeta) {
    await this.rateLimits.consume("writeUser", userId);
    const attempt = await this.ownedAttempt(userId, attemptId);
    if (attempt.status !== AttemptStatus.IN_PROGRESS) throw conflict(ErrorCode.ATTEMPT_CLOSED, "Attempt is closed");
    const assessment = await this.assessments.find(attempt.assessmentId);
    const graceDeadline = this.graceDeadline(attempt, assessment);
    if (graceDeadline && graceDeadline <= new Date()) {
      await this.finalize(attemptId, { automatic: true }, meta);
      throw conflict(ErrorCode.ATTEMPT_CLOSED, "Time is over, the attempt was submitted");
    }
    const question = await this.db.attemptQuestion.findFirst({ where: { id: attemptQuestionId, attemptId } });
    if (!question) throw notFound("Question");
    const problem = validateResponseShape(question.snapshot as unknown as QuestionSnapshot, response);
    if (problem) throw badRequest(ErrorCode.VALIDATION_FAILED, problem);
    const saved = await this.db.$transaction(async (tx) => {
      if ((await this.lockAttempt(tx, attemptId)) !== AttemptStatus.IN_PROGRESS) throw conflict(ErrorCode.ATTEMPT_CLOSED, "Attempt is closed");
      return tx.attemptAnswer.upsert({
        where: { attemptQuestionId },
        create: { attemptId, attemptQuestionId, response: response },
        update: { response: response, savedAt: new Date() },
      });
    });
    return { attemptQuestionId, savedAt: saved.savedAt };
  }

  async submit(userId: string, attemptId: string, meta: RequestMeta) {
    const attempt = await this.ownedAttempt(userId, attemptId);
    if (attempt.status === AttemptStatus.IN_PROGRESS) await this.finalize(attemptId, { automatic: false }, meta);
    return this.result(userId, attemptId);
  }

  async finalize(attemptId: string, options: { automatic: boolean }, meta: RequestMeta): Promise<void> {
    const outcome = await this.db.$transaction(async (tx) => {
      const now = new Date();
      const claimed = await tx.assessmentAttempt.updateMany({
        where: { id: attemptId, status: AttemptStatus.IN_PROGRESS },
        data: { status: AttemptStatus.SUBMITTED, submittedAt: now, autoSubmitted: options.automatic },
      });
      if (claimed.count === 0) return null;
      const attempt = await tx.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      const questions = await tx.attemptQuestion.findMany({ where: { attemptId }, include: { answer: true } });
      let pendingManual = false;
      for (const question of questions) {
        const response = (question.answer?.response ?? null) as AnswerResponse | null;
        const hasResponse = response !== null && Object.keys(response).length > 0;
        const grade = gradeResponse(question.type, question.answerKey as unknown as AnswerKey, hasResponse ? response : null, Number(question.points));
        const manual = grade.mode === "MANUAL" && hasResponse;
        if (manual) pendingManual = true;
        const data = {
          isCorrect: manual ? null : (grade.isCorrect ?? false),
          awardedPoints: manual ? null : new Prisma.Decimal(grade.awardedPoints ?? 0),
          gradingMode: manual ? null : GradingMode.AUTO,
          gradedAt: manual ? null : now,
        };
        await tx.attemptAnswer.upsert({
          where: { attemptQuestionId: question.id },
          create: { attemptId, attemptQuestionId: question.id, response: (response ?? {}), ...data },
          update: data,
        });
      }
      if (pendingManual) {
        await tx.assessmentAttempt.update({ where: { id: attemptId }, data: { status: AttemptStatus.PENDING_REVIEW } });
        await this.upsertResultCount(tx, attempt);
        return { attempt, completedLessonId: null as string | null };
      }
      const completedLessonId = await this.completeGrading(tx, attemptId, meta.requestId);
      return { attempt, completedLessonId };
    });
    if (outcome?.completedLessonId) {
      await this.progress.complete(outcome.attempt.userId, outcome.completedLessonId, meta, { fromAssessment: true }).catch(() => undefined);
    }
  }

  private async upsertResultCount(tx: Tx, attempt: AssessmentAttempt) {
    const attemptsCount = await tx.assessmentAttempt.count({ where: { assessmentId: attempt.assessmentId, userId: attempt.userId, status: { not: AttemptStatus.VOIDED } } });
    await tx.assessmentResult.upsert({
      where: { assessmentId_userId: { assessmentId: attempt.assessmentId, userId: attempt.userId } },
      create: { assessmentId: attempt.assessmentId, userId: attempt.userId, enrollmentId: attempt.enrollmentId, attemptsCount, lastAttemptId: attempt.id },
      update: { attemptsCount, lastAttemptId: attempt.id },
    });
  }

  private async completeGrading(tx: Tx, attemptId: string, requestId: string | null): Promise<string | null> {
    const attempt = await tx.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { assessment: true, answers: true } });
    const assessment = attempt.assessment;
    const scorePoints = roundPoints(attempt.answers.reduce((sum, answer) => sum + Number(answer.awardedPoints ?? 0), 0));
    const maxPoints = Number(attempt.maxPoints);
    const scorePercent = maxPoints > 0 ? roundPoints((scorePoints / maxPoints) * 100) : 0;
    const passing = assessment.passingScorePercent === null ? null : Number(assessment.passingScorePercent);
    const passed = passing === null ? null : scorePercent >= passing;
    await tx.assessmentAttempt.update({
      where: { id: attemptId },
      data: { status: AttemptStatus.GRADED, gradedAt: new Date(), scorePoints: new Prisma.Decimal(scorePoints), scorePercent: new Prisma.Decimal(scorePercent), passed },
    });
    const recalculated = await this.recalculateResult(tx, assessment, attempt.userId, attempt.enrollmentId);
    const resultPassed = recalculated.passed;
    await tx.activityEvent.create({ data: { userId: attempt.userId, courseId: assessment.courseId, enrollmentId: attempt.enrollmentId, verb: "assessment.attempt.graded", data: { assessmentId: assessment.id, scorePercent } } });
    if (isVisible(assessment.feedbackPolicy, assessment)) {
      await this.notifications.notify(tx, {
        userId: attempt.userId,
        category: NotificationCategory.ACADEMIC,
        type: NotificationType.AssessmentGraded,
        params: { assessment: assessment.title, score: scorePercent },
        target: { kind: "attempt", id: attempt.id, parentId: assessment.id },
        institutionId: assessment.institutionId,
        requestId,
      });
    }
    if (resultPassed === false) return null;
    const lesson = await tx.lesson.findUnique({ where: { assessmentId: assessment.id }, select: { id: true } });
    return lesson?.id ?? null;
  }

  async recalculateResult(tx: Tx, assessment: Assessment, userId: string, enrollmentId: string | null): Promise<RecalculatedResult> {
    const attempts = await tx.assessmentAttempt.findMany({
      where: { assessmentId: assessment.id, userId, status: { not: AttemptStatus.VOIDED } },
      select: { id: true, status: true, scorePercent: true, submittedAt: true, attemptNumber: true, enrollmentId: true },
      orderBy: { attemptNumber: "desc" },
    });
    const graded = attempts.filter((item) => item.status === AttemptStatus.GRADED);
    const aggregate = aggregateScore(
      assessment.scoringPolicy,
      graded.map((item) => ({ scorePercent: Number(item.scorePercent ?? 0), submittedAt: item.submittedAt ?? new Date(0) })),
    );
    const passing = assessment.passingScorePercent === null ? null : Number(assessment.passingScorePercent);
    const passed = passing === null || aggregate === null ? null : aggregate >= passing;
    const lastAttemptId = attempts[0]?.id ?? null;
    const resolvedEnrollmentId = enrollmentId ?? attempts.find((item) => item.enrollmentId)?.enrollmentId ?? null;
    const data = {
      attemptsCount: attempts.length,
      scorePercent: aggregate === null ? null : new Prisma.Decimal(aggregate),
      passed,
      lastAttemptId,
    };
    await tx.assessmentResult.upsert({
      where: { assessmentId_userId: { assessmentId: assessment.id, userId } },
      create: { assessmentId: assessment.id, userId, enrollmentId: resolvedEnrollmentId, ...data },
      update: data,
    });
    if (resolvedEnrollmentId) await this.updateCourseGrade(tx, resolvedEnrollmentId, userId, assessment.courseId);
    return { attemptsCount: attempts.length, gradedAttempts: graded.length, scorePercent: aggregate, passed, lastAttemptId };
  }

  private async updateCourseGrade(tx: Tx, enrollmentId: string, userId: string, courseId: string) {
    const results = await tx.assessmentResult.findMany({
      where: { userId, scorePercent: { not: null }, assessment: { courseId, deletedAt: null } },
      select: { scorePercent: true, assessment: { select: { weight: true } } },
    });
    const totalWeight = results.reduce((sum, item) => sum + Number(item.assessment.weight), 0);
    const finalScore = totalWeight > 0 ? roundPoints(results.reduce((sum, item) => sum + Number(item.scorePercent) * Number(item.assessment.weight), 0) / totalWeight) : null;
    await tx.enrollment.update({ where: { id: enrollmentId }, data: { finalScorePercent: finalScore === null ? null : new Prisma.Decimal(finalScore) } });
  }

  async grade(actorId: string, attemptId: string, grades: Array<{ attemptQuestionId: string; points: number; feedback?: string | null }>, meta: RequestMeta) {
    const attempt = await this.db.assessmentAttempt.findUnique({ where: { id: attemptId }, include: { assessment: true } });
    if (!attempt) throw notFound("Attempt");
    await this.access.requireManage(actorId, attempt.assessment.courseId, Permission.AssessmentGrade);
    if (attempt.status !== AttemptStatus.PENDING_REVIEW && attempt.status !== AttemptStatus.GRADED) throw conflict(ErrorCode.BUSINESS_RULE, "Only submitted attempts can be graded");
    const completedLessonId = await this.db.$transaction(async (tx) => {
      const lockedStatus = await this.lockAttempt(tx, attemptId);
      if (lockedStatus !== AttemptStatus.PENDING_REVIEW && lockedStatus !== AttemptStatus.GRADED) throw conflict(ErrorCode.BUSINESS_RULE, "Only submitted attempts can be graded");
      for (const item of grades) {
        const question = await tx.attemptQuestion.findFirst({ where: { id: item.attemptQuestionId, attemptId } });
        if (!question) throw notFound("Question");
        if (item.points < 0 || item.points > Number(question.points)) throw badRequest(ErrorCode.VALIDATION_FAILED, "Points exceed the question value");
        await tx.attemptAnswer.upsert({
          where: { attemptQuestionId: question.id },
          create: {
            attemptId,
            attemptQuestionId: question.id,
            response: {},
            awardedPoints: new Prisma.Decimal(item.points),
            isCorrect: item.points === Number(question.points),
            gradingMode: GradingMode.MANUAL,
            feedback: item.feedback ?? null,
            gradedById: actorId,
            gradedAt: new Date(),
          },
          update: {
            awardedPoints: new Prisma.Decimal(item.points),
            isCorrect: item.points === Number(question.points),
            gradingMode: GradingMode.MANUAL,
            feedback: item.feedback ?? null,
            gradedById: actorId,
            gradedAt: new Date(),
          },
        });
      }
      const pending = await tx.attemptAnswer.count({ where: { attemptId, awardedPoints: null } });
      const unanswered = await tx.attemptQuestion.count({ where: { attemptId, answer: null } });
      await this.audit.record(
        {
          action: "assessment.attempt.graded_manually",
          category: AuditCategory.ACADEMIC,
          actorId,
          resourceType: "attempt",
          resourceId: attemptId,
          institutionId: attempt.assessment.institutionId,
          metadata: { questions: grades.length },
          meta,
        },
        tx,
      );
      if (pending > 0 || unanswered > 0) return null;
      return this.completeGrading(tx, attemptId, meta.requestId);
    });
    if (completedLessonId) await this.progress.complete(attempt.userId, completedLessonId, meta, { fromAssessment: true }).catch(() => undefined);
    return this.staffResult(actorId, attemptId);
  }

  private presentCorrectAnswer(type: QuestionType, key: AnswerKey): Record<string, unknown> {
    switch (type) {
      case QuestionType.SINGLE_CHOICE:
      case QuestionType.MULTIPLE_CHOICE:
        return { optionIds: key.correctOptionIds ?? [] };
      case QuestionType.TRUE_FALSE:
        return { value: key.booleanAnswer };
      case QuestionType.NUMERIC:
        return { value: key.numericAnswer, tolerance: key.tolerance ?? 0 };
      case QuestionType.SHORT_ANSWER:
        return { acceptedAnswers: key.acceptedAnswers ?? [] };
      case QuestionType.MATCHING:
        return { pairs: key.matchingPairs ?? {} };
      case QuestionType.ORDERING:
        return { order: key.orderedOptionIds ?? [] };
      default:
        return {};
    }
  }

  private async buildResult(attemptId: string, audience: "learner" | "staff") {
    const attempt = await this.db.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { assessment: true } });
    const assessment = attempt.assessment;
    const finished = attempt.status === AttemptStatus.GRADED || attempt.status === AttemptStatus.PENDING_REVIEW;
    const showScore = audience === "staff" || (finished && isVisible(assessment.feedbackPolicy, assessment));
    const showAnswers = audience === "staff" || (finished && isVisible(assessment.revealAnswersPolicy, assessment));
    const questions = await this.db.attemptQuestion.findMany({ where: { attemptId }, orderBy: { position: "asc" }, include: { answer: true } });
    return {
      attemptId: attempt.id,
      assessmentId: assessment.id,
      userId: attempt.userId,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      autoSubmitted: attempt.autoSubmitted,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      gradedAt: attempt.gradedAt,
      scoreVisible: showScore,
      scorePoints: showScore && attempt.scorePoints !== null ? Number(attempt.scorePoints) : null,
      maxPoints: Number(attempt.maxPoints),
      scorePercent: showScore && attempt.scorePercent !== null ? Number(attempt.scorePercent) : null,
      passed: showScore ? attempt.passed : null,
      questions: questions.map((question) => {
        const snapshot = question.snapshot as unknown as QuestionSnapshot;
        const key = question.answerKey as unknown as AnswerKey;
        return {
          id: question.id,
          position: question.position,
          type: question.type,
          prompt: snapshot.prompt,
          points: Number(question.points),
          options: snapshot.options ?? null,
          items: snapshot.items ?? null,
          targets: snapshot.targets ?? null,
          response: (question.answer?.response ?? null) as Record<string, unknown> | null,
          isCorrect: showScore ? (question.answer?.isCorrect ?? null) : null,
          awardedPoints: showScore && question.answer?.awardedPoints !== null && question.answer?.awardedPoints !== undefined ? Number(question.answer.awardedPoints) : null,
          feedback: showScore ? (question.answer?.feedback ?? null) : null,
          correctAnswer: showAnswers ? this.presentCorrectAnswer(question.type, key) : null,
          explanation: showAnswers ? (key.explanation ?? null) : null,
          optionFeedback: showAnswers ? (key.optionFeedback ?? {}) : null,
        };
      }),
    };
  }

  async result(userId: string, attemptId: string) {
    await this.ownedAttempt(userId, attemptId);
    return this.buildResult(attemptId, "learner");
  }

  async staffResult(actorId: string, attemptId: string) {
    const attempt = await this.db.assessmentAttempt.findUnique({ where: { id: attemptId }, include: { assessment: { select: { courseId: true } } } });
    if (!attempt) throw notFound("Attempt");
    await this.access.requireManage(actorId, attempt.assessment.courseId, Permission.AssessmentRead);
    return this.buildResult(attemptId, "staff");
  }

  async listForStaff(actorId: string, assessmentId: string, query: { page: number; pageSize: number; status?: AttemptStatus }) {
    await this.assessments.requireManage(actorId, assessmentId, Permission.AssessmentRead);
    const where: Prisma.AssessmentAttemptWhereInput = { assessmentId, ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await Promise.all([
      this.db.assessmentAttempt.findMany({
        where,
        include: { user: { select: { id: true, displayName: true, email: true } } },
        orderBy: { startedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.assessmentAttempt.count({ where }),
    ]);
    return {
      data: items.map((item) => ({
        id: item.id,
        attemptNumber: item.attemptNumber,
        status: item.status,
        startedAt: item.startedAt,
        submittedAt: item.submittedAt,
        autoSubmitted: item.autoSubmitted,
        scorePercent: item.scorePercent === null ? null : Number(item.scorePercent),
        passed: item.passed,
        user: item.user,
      })),
      meta: offsetMetaOf(query.page, query.pageSize, total),
    };
  }

  async autoSubmitIfDue(attemptId: string, meta: RequestMeta): Promise<boolean> {
    const attempt = await this.db.assessmentAttempt.findUnique({ where: { id: attemptId }, include: { assessment: true } });
    if (attempt?.status !== AttemptStatus.IN_PROGRESS) return false;
    const graceDeadline = this.graceDeadline(attempt, attempt.assessment);
    if (graceDeadline && graceDeadline > new Date()) return false;
    await this.finalize(attemptId, { automatic: true }, meta);
    return true;
  }

  async voidAttempt(actorId: string, attemptId: string, reason: string, meta: RequestMeta): Promise<RecalculatedResult | null> {
    const attempt = await this.db.assessmentAttempt.findUnique({ where: { id: attemptId }, include: { assessment: true } });
    if (!attempt) throw notFound("Attempt");
    await this.access.requireManage(actorId, attempt.assessment.courseId, Permission.AssessmentGrade);
    const outcome = await this.db.$transaction(async (tx) => {
      const claimed = await tx.assessmentAttempt.updateMany({ where: { id: attemptId, status: { not: AttemptStatus.VOIDED } }, data: { status: AttemptStatus.VOIDED } });
      if (claimed.count === 0) return null;
      const recalculated = await this.recalculateResult(tx, attempt.assessment, attempt.userId, attempt.enrollmentId);
      await tx.activityEvent.create({
        data: {
          userId: attempt.userId,
          courseId: attempt.assessment.courseId,
          enrollmentId: attempt.enrollmentId,
          verb: "assessment.attempt.voided",
          data: { assessmentId: attempt.assessmentId, attemptId, previousStatus: attempt.status },
        },
      });
      await this.audit.record(
        {
          action: "assessment.attempt.voided",
          category: AuditCategory.ACADEMIC,
          actorId,
          resourceType: "attempt",
          resourceId: attemptId,
          institutionId: attempt.assessment.institutionId,
          metadata: { reason, previousStatus: attempt.status, learnerId: attempt.userId, result: { ...recalculated } },
          meta,
        },
        tx,
      );
      return recalculated;
    });
    if (!outcome) return null;
    await this.syncAssessmentLesson(attempt.userId, attempt.assessment, outcome.passed, meta);
    return outcome;
  }

  private async syncAssessmentLesson(userId: string, assessment: Assessment, passed: boolean | null, meta: RequestMeta): Promise<void> {
    const lesson = await this.db.lesson.findUnique({ where: { assessmentId: assessment.id }, select: { id: true } });
    if (!lesson) return;
    if (passed === false || passed === null) {
      const graded = await this.db.assessmentAttempt.count({ where: { assessmentId: assessment.id, userId, status: AttemptStatus.GRADED } });
      if (passed === null && graded > 0) return;
      await this.progress.reopenAssessmentLesson(userId, assessment.courseId, lesson.id, meta.requestId);
      return;
    }
    await this.progress.complete(userId, lesson.id, meta, { fromAssessment: true }).catch(() => undefined);
  }
}
