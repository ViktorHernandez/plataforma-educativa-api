import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { dataEnvelope, idParams, isoDateTime, offsetPage, offsetQuery, okResponse, standardErrors, trimmedString } from "../../core/http/schemas.js";
import {
  AssessmentItemKind,
  AssessmentStatus,
  AssessmentType,
  AttemptStatus,
  QuestionDifficulty,
  QuestionStatus,
  QuestionType,
  RevealPolicy,
  ScoringPolicy,
} from "../../generated/prisma/enums.js";
import { answerResponse, optionInput } from "./question-types.js";

const security = [{ bearerAuth: [] }];
const tags = ["Assessments"];

const questionBody = z
  .object({
    type: z.enum(QuestionType),
    prompt: z.string().trim().min(1).max(20_000),
    explanation: z.string().trim().max(10_000).nullable().optional(),
    points: z.number().min(0).max(1000).optional(),
    difficulty: z.enum(QuestionDifficulty).nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
    status: z.enum(QuestionStatus).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    options: z.array(optionInput).max(50).optional(),
  })
  .strict();

const questionSchema = z.object({
  id: z.uuid(),
  bankId: z.uuid(),
  categoryId: z.uuid().nullable(),
  type: z.enum(QuestionType),
  status: z.enum(QuestionStatus),
  difficulty: z.enum(QuestionDifficulty).nullable(),
  prompt: z.string(),
  explanation: z.string().nullable(),
  points: z.number(),
  config: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
  version: z.number().int(),
  options: z.array(z.object({ id: z.uuid(), position: z.number().int(), text: z.string(), isCorrect: z.boolean(), feedback: z.string().nullable(), matchTarget: z.string().nullable() })),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

const bankSchema = z.object({
  id: z.uuid(),
  institutionId: z.uuid(),
  courseId: z.uuid().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

const assessmentBody = z
  .object({
    title: trimmedString(2, 200),
    instructions: z.string().max(20_000).nullable().optional(),
    type: z.enum(AssessmentType).optional(),
    opensAt: isoDateTime.nullable().optional(),
    closesAt: isoDateTime.nullable().optional(),
    timeLimitSeconds: z.number().int().min(30).max(86_400).nullable().optional(),
    gracePeriodSeconds: z.number().int().min(0).max(600).optional(),
    maxAttempts: z.number().int().min(1).max(100).nullable().optional(),
    scoringPolicy: z.enum(ScoringPolicy).optional(),
    passingScorePercent: z.number().min(0).max(100).nullable().optional(),
    shuffleQuestions: z.boolean().optional(),
    shuffleOptions: z.boolean().optional(),
    feedbackPolicy: z.enum(RevealPolicy).optional(),
    revealAnswersPolicy: z.enum(RevealPolicy).optional(),
    weight: z.number().min(0).max(1000).optional(),
  })
  .strict();

const assessmentSchema = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  institutionId: z.uuid(),
  title: z.string(),
  instructions: z.string().nullable(),
  type: z.enum(AssessmentType),
  status: z.enum(AssessmentStatus),
  opensAt: isoDateTime.nullable(),
  closesAt: isoDateTime.nullable(),
  timeLimitSeconds: z.number().int().nullable(),
  gracePeriodSeconds: z.number().int(),
  maxAttempts: z.number().int().nullable(),
  scoringPolicy: z.enum(ScoringPolicy),
  passingScorePercent: z.number().nullable(),
  shuffleQuestions: z.boolean(),
  shuffleOptions: z.boolean(),
  feedbackPolicy: z.enum(RevealPolicy),
  revealAnswersPolicy: z.enum(RevealPolicy),
  weight: z.number(),
  publishedAt: isoDateTime.nullable(),
  version: z.number().int(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

type AssessmentRow = Omit<z.infer<typeof assessmentSchema>, "passingScorePercent" | "weight"> & { passingScorePercent: unknown; weight: unknown };

function presentAssessment(row: AssessmentRow): z.infer<typeof assessmentSchema> {
  return {
    ...row,
    passingScorePercent: row.passingScorePercent === null || row.passingScorePercent === undefined ? null : Number(row.passingScorePercent),
    weight: Number(row.weight),
  };
}

const itemInput = z
  .object({
    kind: z.enum(AssessmentItemKind),
    questionId: z.uuid().optional(),
    bankId: z.uuid().optional(),
    categoryId: z.uuid().nullable().optional(),
    difficulty: z.enum(QuestionDifficulty).nullable().optional(),
    drawCount: z.number().int().min(1).max(200).optional(),
    pointsOverride: z.number().min(0).max(1000).nullable().optional(),
  })
  .strict();

const itemSchema = z.object({
  id: z.uuid(),
  position: z.number().int(),
  kind: z.enum(AssessmentItemKind),
  questionId: z.uuid().nullable(),
  bankId: z.uuid().nullable(),
  categoryId: z.uuid().nullable(),
  difficulty: z.enum(QuestionDifficulty).nullable(),
  drawCount: z.number().int(),
  pointsOverride: z.number().nullable(),
});

const presentedQuestion = z.object({
  id: z.uuid(),
  position: z.number().int(),
  type: z.enum(QuestionType),
  prompt: z.string(),
  points: z.number(),
  options: z.array(z.object({ id: z.string(), text: z.string() })).nullable(),
  items: z.array(z.object({ id: z.string(), text: z.string() })).nullable(),
  targets: z.array(z.object({ key: z.string(), text: z.string() })).nullable(),
});

const attemptView = z.object({
  id: z.uuid(),
  assessmentId: z.uuid(),
  attemptNumber: z.number().int(),
  status: z.enum(AttemptStatus),
  startedAt: isoDateTime,
  deadlineAt: isoDateTime.nullable(),
  submittedAt: isoDateTime.nullable(),
  serverTime: isoDateTime,
  questions: z.array(
    presentedQuestion.extend({
      minWords: z.number().int().nullable(),
      maxWords: z.number().int().nullable(),
      savedResponse: z.record(z.string(), z.unknown()).nullable(),
      savedAt: isoDateTime.nullable(),
    }),
  ),
});

const resultView = z.object({
  attemptId: z.uuid(),
  assessmentId: z.uuid(),
  userId: z.uuid(),
  attemptNumber: z.number().int(),
  status: z.enum(AttemptStatus),
  autoSubmitted: z.boolean(),
  startedAt: isoDateTime,
  submittedAt: isoDateTime.nullable(),
  gradedAt: isoDateTime.nullable(),
  scoreVisible: z.boolean(),
  scorePoints: z.number().nullable(),
  maxPoints: z.number(),
  scorePercent: z.number().nullable(),
  passed: z.boolean().nullable(),
  questions: z.array(
    presentedQuestion.extend({
      response: z.record(z.string(), z.unknown()).nullable(),
      isCorrect: z.boolean().nullable(),
      awardedPoints: z.number().nullable(),
      feedback: z.string().nullable(),
      correctAnswer: z.record(z.string(), z.unknown()).nullable(),
      explanation: z.string().nullable(),
      optionFeedback: z.record(z.string(), z.string()).nullable(),
    }),
  ),
});

export function registerAssessmentRoutes(app: AppInstance, container: Container): void {
  const { questionBanks, assessments, attempts, accommodations, authenticator, idempotency } = container;
  const institutionParams = z.object({ institutionId: z.uuid() }).strict();

  app.post(
    "/institutions/:institutionId/question-banks",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Create a question bank",
        params: institutionParams,
        body: z.object({ title: trimmedString(2, 200), description: z.string().trim().max(1000).nullable().optional(), courseId: z.uuid().nullable().optional() }).strict(),
        response: { 201: dataEnvelope(bankSchema), ...standardErrors },
      },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await questionBanks.createBank(requireAuth(request).userId, request.params.institutionId, request.body, requestMeta(request)) };
    },
  );

  app.get(
    "/institutions/:institutionId/question-banks",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Question banks",
        params: institutionParams,
        querystring: z.object({ courseId: z.uuid().optional() }).strict(),
        response: { 200: dataEnvelope(z.array(bankSchema.extend({ _count: z.object({ questions: z.number().int() }) }))), ...standardErrors },
      },
    },
    async (request) => ({ data: await questionBanks.listBanks(requireAuth(request).userId, request.params.institutionId, request.query.courseId) }),
  );

  app.get(
    "/question-banks/:id/categories",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Bank categories",
        params: idParams,
        response: { 200: dataEnvelope(z.array(z.object({ id: z.uuid(), name: z.string(), _count: z.object({ questions: z.number().int() }) }))), ...standardErrors },
      },
    },
    async (request) => ({ data: await questionBanks.categories(requireAuth(request).userId, request.params.id) }),
  );

  app.post(
    "/question-banks/:id/categories",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Create a bank category", params: idParams, body: z.object({ name: trimmedString(1, 120) }).strict(), response: { 201: dataEnvelope(z.object({ id: z.uuid(), name: z.string() })), ...standardErrors } },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await questionBanks.createCategory(requireAuth(request).userId, request.params.id, request.body.name) };
    },
  );

  app.get(
    "/question-banks/:id/questions",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Questions in a bank",
        params: idParams,
        querystring: offsetQuery
          .extend({
            categoryId: z.uuid().optional(),
            type: z.enum(QuestionType).optional(),
            status: z.enum(QuestionStatus).optional(),
            difficulty: z.enum(QuestionDifficulty).optional(),
            tag: z.string().max(40).optional(),
            search: z.string().trim().max(100).optional(),
          })
          .strict(),
        response: { 200: offsetPage(questionSchema), ...standardErrors },
      },
    },
    async (request) => questionBanks.list(requireAuth(request).userId, request.params.id, request.query),
  );

  app.post(
    "/question-banks/:id/questions",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Create a question", params: idParams, body: questionBody, response: { 201: dataEnvelope(questionSchema), ...standardErrors } } },
    async (request, reply) => {
      reply.code(201);
      return { data: await questionBanks.createQuestion(requireAuth(request).userId, request.params.id, request.body, requestMeta(request)) };
    },
  );

  app.get(
    "/questions/:id",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Question detail", params: idParams, response: { 200: dataEnvelope(questionSchema), ...standardErrors } } },
    async (request) => ({ data: await questionBanks.get(requireAuth(request).userId, request.params.id) }),
  );

  app.put(
    "/questions/:id",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Replace a question (creates a new version)", params: idParams, body: questionBody, response: { 200: dataEnvelope(questionSchema), ...standardErrors } } },
    async (request) => ({ data: await questionBanks.updateQuestion(requireAuth(request).userId, request.params.id, request.body, requestMeta(request)) }),
  );

  app.post(
    "/questions/:id/status",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Activate or retire a question", params: idParams, body: z.object({ status: z.enum(QuestionStatus) }).strict(), response: { 200: dataEnvelope(questionSchema), ...standardErrors } },
    },
    async (request) => ({ data: await questionBanks.setStatus(requireAuth(request).userId, request.params.id, request.body.status) }),
  );

  app.post(
    "/courses/:id/assessments",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Create an assessment", params: idParams, body: assessmentBody, response: { 201: dataEnvelope(assessmentSchema), ...standardErrors } } },
    async (request, reply) => {
      reply.code(201);
      return { data: presentAssessment(await assessments.create(requireAuth(request).userId, request.params.id, request.body, requestMeta(request))) };
    },
  );

  app.get(
    "/courses/:id/assessments",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Assessments of a course", params: idParams, response: { 200: dataEnvelope(z.array(assessmentSchema)), ...standardErrors } } },
    async (request) => ({ data: (await assessments.listForCourse(requireAuth(request).userId, request.params.id)).map(presentAssessment) }),
  );

  app.patch(
    "/assessments/:id",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Update an assessment", params: idParams, body: assessmentBody.partial().strict(), response: { 200: dataEnvelope(assessmentSchema), ...standardErrors } } },
    async (request) => ({ data: presentAssessment(await assessments.update(requireAuth(request).userId, request.params.id, request.body, requestMeta(request))) }),
  );

  app.get(
    "/assessments/:id/items",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Assessment blueprint", params: idParams, response: { 200: dataEnvelope(z.array(itemSchema)), ...standardErrors } } },
    async (request) => {
      await assessments.requireManage(requireAuth(request).userId, request.params.id);
      return { data: await assessments.items(request.params.id) };
    },
  );

  app.put(
    "/assessments/:id/items",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Replace fixed questions and random pools", params: idParams, body: z.object({ items: z.array(itemInput).min(1).max(200) }).strict(), response: { 200: dataEnvelope(z.array(itemSchema)), ...standardErrors } },
    },
    async (request) => ({ data: await assessments.setItems(requireAuth(request).userId, request.params.id, request.body.items, requestMeta(request)) }),
  );

  app.post(
    "/assessments/:id/status",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Publish, close or archive", params: idParams, body: z.object({ status: z.enum(AssessmentStatus) }).strict(), response: { 200: dataEnvelope(assessmentSchema), ...standardErrors } },
    },
    async (request) => ({ data: presentAssessment(await assessments.setStatus(requireAuth(request).userId, request.params.id, request.body.status, requestMeta(request))) }),
  );

  app.get(
    "/assessments/:id",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Assessment overview for the current learner",
        params: idParams,
        response: {
          200: dataEnvelope(
            z.object({
              id: z.uuid(),
              courseId: z.uuid(),
              title: z.string(),
              instructions: z.string().nullable(),
              type: z.enum(AssessmentType),
              availability: z.enum(["DRAFT", "UPCOMING", "OPEN", "CLOSED"]),
              opensAt: isoDateTime.nullable(),
              closesAt: isoDateTime.nullable(),
              timeLimitSeconds: z.number().int().nullable(),
              maxAttempts: z.number().int().nullable(),
              attemptsUsed: z.number().int(),
              attemptsRemaining: z.number().int().nullable(),
              questionCount: z.number().int(),
              passingScorePercent: z.number().nullable(),
              scoringPolicy: z.enum(ScoringPolicy),
              inProgressAttemptId: z.uuid().nullable(),
              result: z.object({ scorePercent: z.number().nullable(), passed: z.boolean().nullable(), attemptsCount: z.number().int() }).nullable(),
              attempts: z.array(z.object({ id: z.uuid(), attemptNumber: z.number().int(), status: z.enum(AttemptStatus), startedAt: isoDateTime, submittedAt: isoDateTime.nullable(), scorePercent: z.number().nullable() })),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await assessments.learnerView(requireAuth(request).userId, request.params.id) }),
  );

  app.get(
    "/assessments/:id/statistics",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Assessment statistics",
        params: idParams,
        response: {
          200: dataEnvelope(
            z.object({
              assessmentId: z.uuid(),
              attemptsByStatus: z.array(z.object({ status: z.string(), count: z.number().int() })),
              gradedAttempts: z.number().int(),
              averageScorePercent: z.number().nullable(),
              passRate: z.number().nullable(),
              scoreDistribution: z.array(z.object({ fromPercent: z.number(), toPercent: z.number(), count: z.number().int() })),
              questions: z.array(z.object({ questionId: z.uuid(), answered: z.number().int(), correctRate: z.number().nullable(), averagePoints: z.number().nullable(), maxPoints: z.number().nullable() })),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await assessments.statistics(requireAuth(request).userId, request.params.id) }),
  );

  app.get(
    "/assessments/:id/attempts",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Attempts of all learners",
        params: idParams,
        querystring: offsetQuery.extend({ status: z.enum(AttemptStatus).optional() }).strict(),
        response: {
          200: offsetPage(
            z.object({
              id: z.uuid(),
              attemptNumber: z.number().int(),
              status: z.enum(AttemptStatus),
              startedAt: isoDateTime,
              submittedAt: isoDateTime.nullable(),
              autoSubmitted: z.boolean(),
              scorePercent: z.number().nullable(),
              passed: z.boolean().nullable(),
              user: z.object({ id: z.uuid(), displayName: z.string(), email: z.string() }),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => attempts.listForStaff(requireAuth(request).userId, request.params.id, request.query),
  );

  app.post(
    "/assessments/:id/attempts",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Start or resume an attempt (supports Idempotency-Key)", params: idParams, response: { 201: dataEnvelope(attemptView), ...standardErrors } },
    },
    async (request, reply) => {
      const current = requireAuth(request);
      return idempotency.run(request, reply, "attempt-start", current.userId, async () => ({
        statusCode: 201,
        body: { data: await attempts.start(current.userId, request.params.id, requestMeta(request)) },
      }));
    },
  );

  app.get(
    "/attempts/:id",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Attempt with questions and saved answers", params: idParams, response: { 200: dataEnvelope(attemptView), ...standardErrors } } },
    async (request) => ({ data: await attempts.view(request.params.id, requireAuth(request).userId) }),
  );

  app.put(
    "/attempts/:id/answers/:questionId",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Save an answer",
        params: z.object({ id: z.uuid(), questionId: z.uuid() }).strict(),
        body: z.object({ response: answerResponse }).strict(),
        response: { 200: dataEnvelope(z.object({ attemptQuestionId: z.uuid(), savedAt: isoDateTime })), ...standardErrors },
      },
    },
    async (request) => ({ data: await attempts.saveAnswer(requireAuth(request).userId, request.params.id, request.params.questionId, request.body.response, requestMeta(request)) }),
  );

  app.post(
    "/attempts/:id/submit",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Submit an attempt", params: idParams, response: { 200: dataEnvelope(resultView), ...standardErrors } } },
    async (request) => ({ data: await attempts.submit(requireAuth(request).userId, request.params.id, requestMeta(request)) }),
  );

  app.get(
    "/attempts/:id/result",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Result respecting the feedback policy", params: idParams, response: { 200: dataEnvelope(resultView), ...standardErrors } } },
    async (request) => ({ data: await attempts.result(requireAuth(request).userId, request.params.id) }),
  );

  app.get(
    "/attempts/:id/review",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Full attempt review for graders", params: idParams, response: { 200: dataEnvelope(resultView), ...standardErrors } } },
    async (request) => ({ data: await attempts.staffResult(requireAuth(request).userId, request.params.id) }),
  );

  app.post(
    "/attempts/:id/grades",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Grade answers manually",
        params: idParams,
        body: z
          .object({ grades: z.array(z.object({ attemptQuestionId: z.uuid(), points: z.number().min(0).max(1000), feedback: z.string().trim().max(4000).nullable().optional() }).strict()).min(1).max(200) })
          .strict(),
        response: { 200: dataEnvelope(resultView), ...standardErrors },
      },
    },
    async (request) => ({ data: await attempts.grade(requireAuth(request).userId, request.params.id, request.body.grades, requestMeta(request)) }),
  );

  app.post(
    "/attempts/:id/void",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Void an attempt and recalculate the learner result",
        params: idParams,
        body: z.object({ reason: z.string().trim().min(3).max(500) }).strict(),
        response: {
          200: dataEnvelope(
            z.object({
              ok: z.literal(true),
              result: z
                .object({
                  attemptsCount: z.number().int(),
                  gradedAttempts: z.number().int(),
                  scorePercent: z.number().nullable(),
                  passed: z.boolean().nullable(),
                  lastAttemptId: z.uuid().nullable(),
                })
                .nullable(),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      const result = await attempts.voidAttempt(requireAuth(request).userId, request.params.id, request.body.reason, requestMeta(request));
      return { data: { ok: true as const, result } };
    },
  );

  const accommodationSchema = z.object({
    id: z.uuid(),
    assessmentId: z.uuid(),
    learner: z.object({ id: z.uuid(), displayName: z.string(), email: z.string() }),
    extraTimeSeconds: z.number().int(),
    reason: z.string().nullable(),
    grantedById: z.uuid().nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    revokedAt: isoDateTime.nullable(),
  });
  const accommodationParams = z.object({ id: z.uuid(), userId: z.uuid() }).strict();

  app.get(
    "/assessments/:id/accommodations",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Extra time granted to learners", params: idParams, response: { 200: dataEnvelope(z.array(accommodationSchema)), ...standardErrors } },
    },
    async (request) => ({ data: await accommodations.list(requireAuth(request).userId, request.params.id) }),
  );

  app.put(
    "/assessments/:id/accommodations/:userId",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Grant or update extra time for a learner",
        params: accommodationParams,
        body: z.object({ extraTimeSeconds: z.number().int().min(60).max(86_400), reason: z.string().trim().max(500).nullable().optional() }).strict(),
        response: { 200: dataEnvelope(accommodationSchema.extend({ appliedToAttemptId: z.uuid().nullable() })), ...standardErrors },
      },
    },
    async (request) => ({ data: await accommodations.grant(requireAuth(request).userId, request.params.id, request.params.userId, request.body, requestMeta(request)) }),
  );

  app.delete(
    "/assessments/:id/accommodations/:userId",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Revoke extra time for a learner", params: accommodationParams, response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      await accommodations.revoke(requireAuth(request).userId, request.params.id, request.params.userId, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );
}
