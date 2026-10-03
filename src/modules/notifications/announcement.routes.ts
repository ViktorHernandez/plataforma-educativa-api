import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { cursorPage, cursorQuery, dataEnvelope, idParams, isoDateTime, standardErrors, trimmedString } from "../../core/http/schemas.js";
import { AnnouncementAudience } from "../../generated/prisma/enums.js";

const security = [{ bearerAuth: [] }];
const tags = ["Announcements"];

const announcementSchema = z.object({
  id: z.uuid(),
  institutionId: z.uuid(),
  courseId: z.uuid().nullable(),
  audience: z.enum(AnnouncementAudience),
  title: z.string(),
  body: z.string(),
  publishedAt: isoDateTime,
  author: z.object({ id: z.uuid(), displayName: z.string() }).nullable().optional(),
});

const announcementBody = z.object({ title: trimmedString(3, 200), body: trimmedString(1, 20_000) }).strict();

export function registerAnnouncementRoutes(app: AppInstance, container: Container): void {
  const { announcements, authenticator } = container;

  app.post(
    "/courses/:id/announcements",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Publish a course announcement", params: idParams, body: announcementBody, response: { 201: dataEnvelope(announcementSchema), ...standardErrors } } },
    async (request, reply) => {
      reply.code(201);
      return { data: await announcements.createForCourse(requireAuth(request).userId, request.params.id, request.body, requestMeta(request)) };
    },
  );

  app.get(
    "/courses/:id/announcements",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Course announcements", params: idParams, querystring: cursorQuery.strict(), response: { 200: cursorPage(announcementSchema), ...standardErrors } } },
    async (request) => announcements.listForCourse(requireAuth(request).userId, request.params.id, request.query),
  );

  app.post(
    "/institutions/:id/announcements",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Publish an institution announcement", params: idParams, body: announcementBody, response: { 201: dataEnvelope(announcementSchema), ...standardErrors } },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await announcements.createForInstitution(requireAuth(request).userId, request.params.id, request.body, requestMeta(request)) };
    },
  );

  app.get(
    "/institutions/:id/announcements",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Institution announcements", params: idParams, querystring: cursorQuery.strict(), response: { 200: cursorPage(announcementSchema), ...standardErrors } },
    },
    async (request) => announcements.listForInstitution(requireAuth(request).userId, request.params.id, request.query),
  );
}
