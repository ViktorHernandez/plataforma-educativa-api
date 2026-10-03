import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { ErrorCode, badRequest } from "../../core/http/errors.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { dataEnvelope, idParams, isoDateTime, offsetPage, offsetQuery, okResponse, slug, standardErrors, trimmedString } from "../../core/http/schemas.js";
import { resolveLocale } from "../../core/i18n/translator.js";
import { ContentStatus, CourseStatus } from "../../generated/prisma/enums.js";
import {
  catalogDetailSchema,
  catalogItemSchema,
  catalogQuery,
  cohortBody,
  cohortSchema,
  courseBody,
  courseManageSchema,
  courseSchema,
  courseUpdateBody,
  lessonBody,
  lessonContentSchema,
  lessonSummarySchema,
  outlineSchema,
  programBody,
  programSchema,
  resourceBody,
  sectionBody,
  sectionSchema,
} from "./course.schemas.js";

const security = [{ bearerAuth: [] }];
const institutionParams = z.object({ institutionId: z.uuid() }).strict();

function ifMatchVersion(request: FastifyRequest): number | null {
  const header = request.headers["if-match"];
  if (header === undefined) return null;
  const match = typeof header === "string" ? /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim()) : null;
  if (!match) throw badRequest(ErrorCode.BAD_REQUEST, "If-Match must contain the resource version");
  return Number(match[1]);
}

export function registerCourseRoutes(app: AppInstance, container: Container): void {
  const { courses, structure, catalog, programs, authenticator, users } = container;

  async function viewerLocale(request: FastifyRequest) {
    if (!request.auth) return request.locale;
    return resolveLocale((await users.preferences(request.auth.userId)).locale, request.locale);
  }

  app.get(
    "/catalog/courses",
    { preHandler: authenticator.optional, schema: { tags: ["Catalog"], summary: "Browse published courses", querystring: catalogQuery, response: { 200: offsetPage(catalogItemSchema), ...standardErrors } } },
    async (request) => catalog.list(request.auth?.userId ?? null, request.query, await viewerLocale(request)),
  );

  app.get(
    "/catalog/courses/:id",
    { preHandler: authenticator.optional, schema: { tags: ["Catalog"], summary: "Course landing information", params: idParams, response: { 200: dataEnvelope(catalogDetailSchema), ...standardErrors } } },
    async (request) => ({ data: await catalog.detail(request.auth?.userId ?? null, request.params.id, await viewerLocale(request)) }),
  );

  app.get(
    "/catalog/categories",
    {
      preHandler: authenticator.optional,
      schema: {
        tags: ["Catalog"],
        summary: "Course categories",
        querystring: z.object({ institutionId: z.uuid().optional() }).strict(),
        response: {
          200: dataEnvelope(z.array(z.object({ id: z.uuid(), slug: z.string(), name: z.string(), names: z.record(z.string(), z.string()), parentId: z.uuid().nullable(), institutionId: z.uuid().nullable() }))),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await catalog.categories(request.query.institutionId, await viewerLocale(request)) }),
  );

  app.post(
    "/catalog/categories",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Catalog"],
        security,
        summary: "Create a category",
        body: z
          .object({
            slug,
            names: z.record(z.enum(["es", "en"]), trimmedString(1, 120)).refine((value) => Object.keys(value).length > 0, { message: "At least one translation" }),
            parentId: z.uuid().nullable().optional(),
            institutionId: z.uuid().nullable().optional(),
            position: z.number().int().min(0).max(10_000).optional(),
          })
          .strict(),
        response: { 201: dataEnvelope(z.object({ id: z.uuid(), slug: z.string() })), ...standardErrors },
      },
    },
    async (request, reply) => {
      const category = await catalog.createCategory(requireAuth(request).userId, request.body, requestMeta(request));
      reply.code(201);
      return { data: { id: category.id, slug: category.slug } };
    },
  );

  app.get(
    "/catalog/programs",
    {
      preHandler: authenticator.optional,
      schema: {
        tags: ["Catalog"],
        summary: "Browse published programs and learning paths",
        querystring: offsetQuery.extend({ institutionId: z.uuid().optional() }).strict(),
        response: {
          200: offsetPage(
            z.object({
              id: z.uuid(),
              slug: z.string(),
              kind: z.string(),
              title: z.string(),
              summary: z.string().nullable(),
              level: z.string(),
              estimatedHours: z.number().int().nullable(),
              institution: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }),
              courseCount: z.number().int(),
              publishedAt: isoDateTime.nullable(),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => catalog.programs(request.auth?.userId ?? null, request.query),
  );

  app.get(
    "/programs/:id",
    {
      preHandler: authenticator.optional,
      schema: {
        tags: ["Programs"],
        summary: "Program detail",
        params: idParams,
        response: {
          200: dataEnvelope(
            programSchema.omit({ institutionId: true, publishedAt: true, createdAt: true, updatedAt: true }).extend({
              institution: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }),
              courses: z.array(
                z.object({
                  position: z.number().int(),
                  isRequired: z.boolean(),
                  id: z.uuid(),
                  slug: z.string(),
                  title: z.string(),
                  level: z.string(),
                  estimatedMinutes: z.number().int().nullable(),
                  status: z.string(),
                  visibility: z.string(),
                }),
              ),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await catalog.program(request.auth?.userId ?? null, request.params.id) }),
  );

  app.get(
    "/institutions/:institutionId/programs",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Programs"], security, summary: "Programs managed by an institution", params: institutionParams, response: { 200: dataEnvelope(z.array(programSchema)), ...standardErrors } },
    },
    async (request) => ({ data: await programs.listForInstitution(requireAuth(request).userId, request.params.institutionId) }),
  );

  app.post(
    "/institutions/:institutionId/programs",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Programs"], security, summary: "Create a program", params: institutionParams, body: programBody, response: { 201: dataEnvelope(programSchema), ...standardErrors } },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await programs.create(requireAuth(request).userId, request.params.institutionId, request.body, requestMeta(request)) };
    },
  );

  app.patch(
    "/programs/:id",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Programs"],
        security,
        summary: "Update or publish a program",
        params: idParams,
        body: programBody.partial().extend({ status: z.enum(ContentStatus).optional() }).strict(),
        response: { 200: dataEnvelope(programSchema), ...standardErrors },
      },
    },
    async (request) => ({ data: await programs.update(requireAuth(request).userId, request.params.id, request.body, requestMeta(request)) }),
  );

  app.put(
    "/programs/:id/courses",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Programs"],
        security,
        summary: "Set the ordered courses of a program",
        params: idParams,
        body: z.object({ courses: z.array(z.object({ courseId: z.uuid(), isRequired: z.boolean().default(true) }).strict()).max(200) }).strict(),
        response: { 200: okResponse, ...standardErrors },
      },
    },
    async (request) => {
      await programs.setCourses(requireAuth(request).userId, request.params.id, request.body.courses, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/institutions/:institutionId/courses",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Courses"], security, summary: "Create a course", params: institutionParams, body: courseBody, response: { 201: dataEnvelope(courseSchema), ...standardErrors } },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await courses.create(requireAuth(request).userId, request.params.institutionId, request.body, requestMeta(request)) };
    },
  );

  app.get(
    "/institutions/:institutionId/courses",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Courses"],
        security,
        summary: "Courses managed in an institution",
        params: institutionParams,
        querystring: offsetQuery.extend({ status: z.enum(CourseStatus).optional(), search: z.string().trim().max(100).optional() }).strict(),
        response: { 200: offsetPage(courseSchema), ...standardErrors },
      },
    },
    async (request) => courses.listForStaff(requireAuth(request).userId, request.params.institutionId, request.query),
  );

  app.get(
    "/courses/:id",
    { preHandler: authenticator.required, schema: { tags: ["Courses"], security, summary: "Course configuration for staff", params: idParams, response: { 200: dataEnvelope(courseManageSchema), ...standardErrors } } },
    async (request, reply) => {
      const course = await courses.getForStaff(requireAuth(request).userId, request.params.id);
      reply.header("etag", `"${course.version}"`);
      return { data: course };
    },
  );

  app.patch(
    "/courses/:id",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Courses"], security, summary: "Update a course (optimistic concurrency through If-Match)", params: idParams, body: courseUpdateBody, response: { 200: dataEnvelope(courseManageSchema), ...standardErrors } },
    },
    async (request, reply) => {
      const course = await courses.update(requireAuth(request).userId, request.params.id, ifMatchVersion(request), request.body, requestMeta(request));
      reply.header("etag", `"${course.version}"`);
      return { data: course };
    },
  );

  app.post(
    "/courses/:id/status",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Courses"],
        security,
        summary: "Change course status (review, publish, archive, back to draft)",
        params: idParams,
        body: z.object({ status: z.enum(CourseStatus), publishLessons: z.boolean().default(false) }).strict(),
        response: { 200: dataEnvelope(courseManageSchema), ...standardErrors },
      },
    },
    async (request) => ({
      data: await courses.transition(requireAuth(request).userId, request.params.id, request.body.status, { publishLessons: request.body.publishLessons }, requestMeta(request)),
    }),
  );

  app.delete(
    "/courses/:id",
    { preHandler: authenticator.required, schema: { tags: ["Courses"], security, summary: "Delete a course without enrollments", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await courses.remove(requireAuth(request).userId, request.params.id, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.put(
    "/courses/:id/tags",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Courses"],
        security,
        summary: "Replace course tags",
        params: idParams,
        body: z.object({ tags: z.array(trimmedString(1, 60)).max(20) }).strict(),
        response: { 200: dataEnvelope(z.array(z.string())), ...standardErrors },
      },
    },
    async (request) => ({ data: await courses.setTags(requireAuth(request).userId, request.params.id, request.body.tags) }),
  );

  app.put(
    "/courses/:id/prerequisites",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Courses"],
        security,
        summary: "Replace prerequisites",
        params: idParams,
        body: z.object({ courseIds: z.array(z.uuid()).max(20) }).strict(),
        response: { 200: dataEnvelope(z.array(z.uuid())), ...standardErrors },
      },
    },
    async (request) => ({ data: await courses.setPrerequisites(requireAuth(request).userId, request.params.id, request.body.courseIds, requestMeta(request)) }),
  );

  app.get(
    "/courses/:id/staff",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Courses"],
        security,
        summary: "Course instructors and assistants",
        params: idParams,
        response: {
          200: dataEnvelope(z.array(z.object({ assignmentId: z.uuid(), userId: z.uuid(), displayName: z.string(), email: z.string(), role: z.enum(["INSTRUCTOR", "ASSISTANT"]), createdAt: isoDateTime }))),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await courses.staff(requireAuth(request).userId, request.params.id) }),
  );

  app.post(
    "/courses/:id/staff",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Courses"],
        security,
        summary: "Add an instructor or assistant",
        params: idParams,
        body: z.object({ userId: z.uuid(), role: z.enum(["INSTRUCTOR", "ASSISTANT"]) }).strict(),
        response: { 201: dataEnvelope(z.object({ assignmentId: z.uuid() })), ...standardErrors },
      },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await courses.addStaff(requireAuth(request).userId, request.params.id, request.body, requestMeta(request)) };
    },
  );

  app.delete(
    "/courses/:id/staff/:assignmentId",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Courses"], security, summary: "Remove staff", params: z.object({ id: z.uuid(), assignmentId: z.uuid() }).strict(), response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      await courses.removeStaff(requireAuth(request).userId, request.params.id, request.params.assignmentId, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.get(
    "/courses/:id/cohorts",
    { preHandler: authenticator.optional, schema: { tags: ["Courses"], summary: "Course cohorts", params: idParams, response: { 200: dataEnvelope(z.array(cohortSchema)), ...standardErrors } } },
    async (request) => ({ data: await courses.cohorts(request.auth?.userId ?? null, request.params.id) }),
  );

  app.post(
    "/courses/:id/cohorts",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Courses"], security, summary: "Create a cohort", params: idParams, body: cohortBody, response: { 201: dataEnvelope(cohortSchema), ...standardErrors } },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await courses.createCohort(requireAuth(request).userId, request.params.id, request.body, requestMeta(request)) };
    },
  );

  app.patch(
    "/courses/:id/cohorts/:cohortId",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Courses"],
        security,
        summary: "Update a cohort",
        params: z.object({ id: z.uuid(), cohortId: z.uuid() }).strict(),
        body: cohortBody.partial().strict(),
        response: { 200: dataEnvelope(cohortSchema), ...standardErrors },
      },
    },
    async (request) => ({ data: await courses.updateCohort(requireAuth(request).userId, request.params.id, request.params.cohortId, request.body, requestMeta(request)) }),
  );

  app.get(
    "/courses/:id/outline",
    { preHandler: authenticator.optional, schema: { tags: ["Course content"], summary: "Modules, units and lessons", params: idParams, response: { 200: dataEnvelope(outlineSchema), ...standardErrors } } },
    async (request) => ({ data: await structure.outline(request.auth?.userId ?? null, request.params.id) }),
  );

  app.post(
    "/courses/:id/modules",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Course content"], security, summary: "Create a module", params: idParams, body: sectionBody, response: { 201: dataEnvelope(sectionSchema), ...standardErrors } },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await structure.createModule(requireAuth(request).userId, request.params.id, request.body, requestMeta(request)) };
    },
  );

  app.put(
    "/courses/:id/modules/order",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Course content"], security, summary: "Reorder modules", params: idParams, body: z.object({ ids: z.array(z.uuid()).max(500) }).strict(), response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      await structure.reorder(requireAuth(request).userId, "modules", request.params.id, request.body.ids);
      return { data: { ok: true as const } };
    },
  );

  app.patch(
    "/modules/:id",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Course content"], security, summary: "Update a module", params: idParams, body: sectionBody.partial().strict(), response: { 200: dataEnvelope(sectionSchema), ...standardErrors } },
    },
    async (request) => ({ data: await structure.updateModule(requireAuth(request).userId, request.params.id, request.body) }),
  );

  app.delete(
    "/modules/:id",
    { preHandler: authenticator.required, schema: { tags: ["Course content"], security, summary: "Delete a module", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await structure.deleteModule(requireAuth(request).userId, request.params.id, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/modules/:id/units",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Course content"], security, summary: "Create a unit", params: idParams, body: sectionBody, response: { 201: dataEnvelope(sectionSchema), ...standardErrors } },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await structure.createUnit(requireAuth(request).userId, request.params.id, request.body) };
    },
  );

  app.put(
    "/modules/:id/units/order",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Course content"], security, summary: "Reorder units", params: idParams, body: z.object({ ids: z.array(z.uuid()).max(500) }).strict(), response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      await structure.reorder(requireAuth(request).userId, "units", request.params.id, request.body.ids);
      return { data: { ok: true as const } };
    },
  );

  app.patch(
    "/units/:id",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Course content"], security, summary: "Update a unit", params: idParams, body: sectionBody.partial().strict(), response: { 200: dataEnvelope(sectionSchema), ...standardErrors } },
    },
    async (request) => ({ data: await structure.updateUnit(requireAuth(request).userId, request.params.id, request.body) }),
  );

  app.delete(
    "/units/:id",
    { preHandler: authenticator.required, schema: { tags: ["Course content"], security, summary: "Delete a unit", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await structure.deleteUnit(requireAuth(request).userId, request.params.id);
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/units/:id/lessons",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Course content"], security, summary: "Create a lesson", params: idParams, body: lessonBody, response: { 201: dataEnvelope(lessonSummarySchema), ...standardErrors } },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await structure.createLesson(requireAuth(request).userId, request.params.id, request.body, requestMeta(request)) };
    },
  );

  app.put(
    "/units/:id/lessons/order",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Course content"], security, summary: "Reorder lessons", params: idParams, body: z.object({ ids: z.array(z.uuid()).max(500) }).strict(), response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      await structure.reorder(requireAuth(request).userId, "lessons", request.params.id, request.body.ids);
      return { data: { ok: true as const } };
    },
  );

  app.get(
    "/lessons/:id",
    { preHandler: authenticator.optional, schema: { tags: ["Course content"], summary: "Lesson content (enrolled learners, staff or previews)", params: idParams, response: { 200: dataEnvelope(lessonContentSchema), ...standardErrors } } },
    async (request) => ({ data: await structure.lessonContent(request.auth?.userId ?? null, request.params.id) }),
  );

  app.patch(
    "/lessons/:id",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Course content"], security, summary: "Update a lesson", params: idParams, body: lessonBody.partial().strict(), response: { 200: dataEnvelope(lessonSummarySchema), ...standardErrors } },
    },
    async (request) => ({ data: await structure.updateLesson(requireAuth(request).userId, request.params.id, request.body, requestMeta(request)) }),
  );

  app.delete(
    "/lessons/:id",
    { preHandler: authenticator.required, schema: { tags: ["Course content"], security, summary: "Delete a lesson", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await structure.deleteLesson(requireAuth(request).userId, request.params.id, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/lessons/:id/resources",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Course content"],
        security,
        summary: "Attach a resource",
        params: idParams,
        body: resourceBody,
        response: { 201: dataEnvelope(z.object({ id: z.uuid(), kind: z.string(), title: z.string(), position: z.number().int() })), ...standardErrors },
      },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await structure.addResource(requireAuth(request).userId, request.params.id, request.body) };
    },
  );

  app.delete(
    "/resources/:id",
    { preHandler: authenticator.required, schema: { tags: ["Course content"], security, summary: "Remove a resource", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await structure.removeResource(requireAuth(request).userId, request.params.id);
      return { data: { ok: true as const } };
    },
  );

  app.put(
    "/lessons/:id/media-tracks",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Course content"],
        security,
        summary: "Attach captions, subtitles, audio descriptions or transcripts",
        params: idParams,
        body: z
          .object({
            trackFileId: z.uuid(),
            kind: z.enum(["CAPTIONS", "SUBTITLES", "DESCRIPTIONS", "CHAPTERS", "TRANSCRIPT"]),
            language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/),
            label: trimmedString(1, 80),
            isDefault: z.boolean().optional(),
          })
          .strict(),
        response: { 200: dataEnvelope(z.object({ id: z.uuid(), kind: z.string(), language: z.string() })), ...standardErrors },
      },
    },
    async (request) => ({ data: await structure.addMediaTrack(requireAuth(request).userId, request.params.id, request.body) }),
  );
}
