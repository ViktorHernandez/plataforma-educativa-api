import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { cursorPage, cursorQuery, dataEnvelope, idParams, isoDateTime, offsetPage, offsetQuery, okResponse, standardErrors } from "../../core/http/schemas.js";
import { CertificateStatus, EnrollmentSource, EnrollmentStatus } from "../../generated/prisma/enums.js";

const security = [{ bearerAuth: [] }];

const enrollmentSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  courseId: z.uuid(),
  institutionId: z.uuid(),
  cohortId: z.uuid().nullable(),
  status: z.enum(EnrollmentStatus),
  source: z.enum(EnrollmentSource),
  statusReason: z.string().nullable(),
  enrolledAt: isoDateTime,
  activatedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  cancelledAt: isoDateTime.nullable(),
  expiresAt: isoDateTime.nullable(),
  progressPercent: z.number().int(),
  completedLessons: z.number().int(),
  requiredLessons: z.number().int(),
  lastActivityAt: isoDateTime.nullable(),
  lastLessonId: z.uuid().nullable(),
  finalScorePercent: z.number().nullable(),
});

const lessonProgressSchema = z.object({
  lessonId: z.uuid(),
  status: z.string(),
  progressPercent: z.number().int(),
  positionSeconds: z.number().int().nullable(),
  timeSpentSeconds: z.number().int(),
  firstViewedAt: isoDateTime,
  lastViewedAt: isoDateTime,
  completedAt: isoDateTime.nullable(),
});

const certificateSchema = z.object({
  id: z.uuid(),
  verificationCode: z.string(),
  status: z.enum(CertificateStatus),
  courseId: z.uuid().nullable(),
  learnerName: z.string(),
  courseTitle: z.string(),
  institutionName: z.string(),
  completedAt: isoDateTime,
  finalScorePercent: z.number().nullable(),
  issuedAt: isoDateTime,
  revokedAt: isoDateTime.nullable(),
});

export function registerEnrollmentRoutes(app: AppInstance, container: Container): void {
  const { enrollments, progress, certificates, authenticator, idempotency, rateLimits } = container;

  app.post(
    "/courses/:id/enrollments",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Enrollments"],
        security,
        summary: "Enroll in a course (supports Idempotency-Key)",
        params: idParams,
        body: z.object({ cohortId: z.uuid().nullable().optional() }).strict().nullish(),
        response: { 201: dataEnvelope(enrollmentSchema), ...standardErrors },
      },
    },
    async (request, reply) => {
      const current = requireAuth(request);
      await rateLimits.consume("writeUser", current.userId);
      return idempotency.run(request, reply, "enroll", current.userId, async () => ({
        statusCode: 201,
        body: { data: enrollments.present(await enrollments.enroll(current.userId, request.params.id, { cohortId: request.body?.cohortId ?? null }, requestMeta(request))) },
      }));
    },
  );

  app.post(
    "/courses/:id/enrollments/manage",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Enrollments"],
        security,
        summary: "Enroll a learner as staff",
        params: idParams,
        body: z.object({ userId: z.uuid(), cohortId: z.uuid().nullable().optional() }).strict(),
        response: { 201: dataEnvelope(enrollmentSchema), ...standardErrors },
      },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: enrollments.present(await enrollments.enrollByStaff(requireAuth(request).userId, request.params.id, request.body, requestMeta(request))) };
    },
  );

  app.get(
    "/courses/:id/enrollments",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Enrollments"],
        security,
        summary: "Course roster",
        params: idParams,
        querystring: offsetQuery.extend({ status: z.enum(EnrollmentStatus).optional(), search: z.string().trim().max(100).optional() }).strict(),
        response: { 200: offsetPage(enrollmentSchema.extend({ user: z.object({ id: z.uuid(), email: z.string(), displayName: z.string() }) })), ...standardErrors },
      },
    },
    async (request) => enrollments.listForCourse(requireAuth(request).userId, request.params.id, request.query),
  );

  app.get(
    "/me/enrollments",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Enrollments"],
        security,
        summary: "My enrollments",
        querystring: cursorQuery.extend({ status: z.enum(EnrollmentStatus).optional() }).strict(),
        response: {
          200: cursorPage(
            enrollmentSchema.extend({
              course: z.object({ id: z.uuid(), slug: z.string(), title: z.string(), coverFileId: z.uuid().nullable(), level: z.string(), institution: z.object({ id: z.uuid(), name: z.string() }) }),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => enrollments.mine(requireAuth(request).userId, request.query),
  );

  app.get(
    "/enrollments/:id",
    { preHandler: authenticator.required, schema: { tags: ["Enrollments"], security, summary: "Enrollment detail", params: idParams, response: { 200: dataEnvelope(enrollmentSchema), ...standardErrors } } },
    async (request) => ({ data: enrollments.present(await enrollments.getVisible(requireAuth(request).userId, request.params.id)) }),
  );

  app.get(
    "/enrollments/:id/history",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Enrollments"],
        security,
        summary: "Status history",
        params: idParams,
        response: {
          200: dataEnvelope(z.array(z.object({ id: z.uuid(), fromStatus: z.string().nullable(), toStatus: z.string(), actorId: z.uuid().nullable(), reason: z.string().nullable(), occurredAt: isoDateTime }))),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await enrollments.history(requireAuth(request).userId, request.params.id) }),
  );

  app.post(
    "/enrollments/:id/cancel",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Enrollments"],
        security,
        summary: "Cancel my enrollment",
        params: idParams,
        body: z.object({ reason: z.string().trim().max(500).optional() }).strict().nullish(),
        response: { 200: dataEnvelope(enrollmentSchema), ...standardErrors },
      },
    },
    async (request) => ({ data: enrollments.present(await enrollments.cancel(requireAuth(request).userId, request.params.id, request.body?.reason ?? null, requestMeta(request))) }),
  );

  app.post(
    "/enrollments/:id/actions",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Enrollments"],
        security,
        summary: "Approve, reject, suspend, reactivate or expire an enrollment",
        params: idParams,
        body: z.object({ action: z.enum(["approve", "reject", "suspend", "reactivate", "expire"]), reason: z.string().trim().max(500).optional() }).strict(),
        response: { 200: dataEnvelope(enrollmentSchema), ...standardErrors },
      },
    },
    async (request) => ({
      data: enrollments.present(await enrollments.manage(requireAuth(request).userId, request.params.id, request.body.action, request.body.reason ?? null, requestMeta(request))),
    }),
  );

  app.post(
    "/programs/:id/enrollments",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Enrollments"],
        security,
        summary: "Enroll in every available course of a program",
        params: idParams,
        response: { 200: dataEnvelope(z.object({ programId: z.uuid(), courses: z.array(z.object({ courseId: z.uuid(), outcome: z.string() })) })), ...standardErrors },
      },
    },
    async (request) => ({ data: await enrollments.enrollInProgram(requireAuth(request).userId, request.params.id, requestMeta(request)) }),
  );

  app.get(
    "/enrollments/:id/progress",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Progress"],
        security,
        summary: "Progress by course, module, unit and lesson",
        params: idParams,
        response: {
          200: dataEnvelope(
            z.object({
              enrollmentId: z.uuid(),
              courseId: z.uuid(),
              status: z.string(),
              progressPercent: z.number().int(),
              completedLessons: z.number().int(),
              requiredLessons: z.number().int(),
              totalTimeSpentSeconds: z.number().int(),
              lastActivityAt: isoDateTime.nullable(),
              resumeLessonId: z.uuid().nullable(),
              nextLessonId: z.uuid().nullable(),
              modules: z.array(
                z.object({
                  id: z.uuid(),
                  title: z.string(),
                  progressPercent: z.number().int(),
                  units: z.array(
                    z.object({
                      id: z.uuid(),
                      title: z.string(),
                      progressPercent: z.number().int(),
                      lessons: z.array(
                        z.object({
                          id: z.uuid(),
                          title: z.string(),
                          type: z.string(),
                          isRequired: z.boolean(),
                          status: z.string(),
                          progressPercent: z.number().int(),
                          positionSeconds: z.number().int().nullable(),
                          timeSpentSeconds: z.number().int(),
                          completedAt: isoDateTime.nullable(),
                        }),
                      ),
                    }),
                  ),
                }),
              ),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await progress.enrollmentProgress(requireAuth(request).userId, request.params.id) }),
  );

  app.put(
    "/lessons/:id/progress",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Progress"],
        security,
        summary: "Report playback position, percentage and time spent",
        params: idParams,
        body: z
          .object({
            positionSeconds: z.number().int().min(0).max(86_400).optional(),
            progressPercent: z.number().min(0).max(100).optional(),
            timeSpentDeltaSeconds: z.number().int().min(0).max(3600).optional(),
          })
          .strict(),
        response: { 200: dataEnvelope(lessonProgressSchema), ...standardErrors },
      },
    },
    async (request) => ({ data: await progress.heartbeat(requireAuth(request).userId, request.params.id, request.body, requestMeta(request)) }),
  );

  app.post(
    "/lessons/:id/complete",
    { preHandler: authenticator.required, schema: { tags: ["Progress"], security, summary: "Mark a lesson as completed", params: idParams, response: { 200: dataEnvelope(lessonProgressSchema), ...standardErrors } } },
    async (request) => ({ data: await progress.complete(requireAuth(request).userId, request.params.id, requestMeta(request)) }),
  );

  app.get(
    "/me/certificates",
    { preHandler: authenticator.required, schema: { tags: ["Certificates"], security, summary: "My certificates", response: { 200: dataEnvelope(z.array(certificateSchema)), ...standardErrors } } },
    async (request) => ({ data: await certificates.mine(requireAuth(request).userId) }),
  );

  app.get(
    "/certificates/verify/:code",
    {
      schema: {
        tags: ["Certificates"],
        summary: "Public certificate verification",
        params: z.object({ code: z.string().regex(/^[A-Za-z0-9]{12}$/) }).strict(),
        response: { 200: dataEnvelope(certificateSchema.omit({ id: true, courseId: true })), ...standardErrors },
      },
    },
    async (request) => {
      await rateLimits.consume("tokenRedeemIp", request.client.ip);
      return { data: await certificates.verify(request.params.code) };
    },
  );

  app.post(
    "/certificates/:id/revoke",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Certificates"], security, summary: "Revoke a certificate", params: idParams, body: z.object({ reason: z.string().trim().min(3).max(500) }).strict(), response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      await certificates.revoke(requireAuth(request).userId, request.params.id, request.body.reason, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );
}
