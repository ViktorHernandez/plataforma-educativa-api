import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { dataEnvelope, idParams, isoDateTime, offsetPage, offsetQuery, standardErrors } from "../../core/http/schemas.js";
import { PrivacyRequestStatus, PrivacyRequestType } from "../../generated/prisma/enums.js";
import { reauthSchema } from "../auth/auth.schemas.js";

const security = [{ bearerAuth: [] }];
const tags = ["Privacy"];

export const privacyRequestSchema = z.object({
  id: z.uuid(),
  type: z.enum(PrivacyRequestType),
  status: z.enum(PrivacyRequestStatus),
  requestedAt: isoDateTime,
  scheduledFor: isoDateTime,
  completedAt: isoDateTime.nullable(),
  cancelledAt: isoDateTime.nullable(),
  expiresAt: isoDateTime.nullable(),
  error: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  downloadUrlExpiresAt: isoDateTime.nullable(),
});

export function registerPrivacyRoutes(app: AppInstance, container: Container): void {
  const { privacy, auth, authenticator } = container;

  app.post(
    "/me/privacy/exports",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Request a machine readable copy of all personal data",
        body: z.object({ reauth: reauthSchema.optional() }).strict(),
        response: { 202: dataEnvelope(privacyRequestSchema), ...standardErrors },
      },
    },
    async (request, reply) => {
      const current = requireAuth(request);
      await auth.verifyReauthentication(current.userId, current.authenticatedAt, request.body.reauth, requestMeta(request));
      reply.code(202);
      return { data: await privacy.requestExport(current.userId, requestMeta(request)) };
    },
  );

  app.post(
    "/me/privacy/deletion",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Schedule the deletion and anonymization of the account",
        body: z.object({ confirmation: z.literal("DELETE_MY_ACCOUNT"), reauth: reauthSchema.optional() }).strict(),
        response: { 202: dataEnvelope(privacyRequestSchema), ...standardErrors },
      },
    },
    async (request, reply) => {
      const current = requireAuth(request);
      await auth.verifyReauthentication(current.userId, current.authenticatedAt, request.body.reauth, requestMeta(request));
      reply.code(202);
      return { data: await privacy.requestDeletion(current.userId, requestMeta(request)) };
    },
  );

  app.get(
    "/me/privacy/requests",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Privacy requests of the current user", response: { 200: dataEnvelope(z.array(privacyRequestSchema)), ...standardErrors } } },
    async (request) => ({ data: await privacy.list(requireAuth(request).userId) }),
  );

  app.get(
    "/me/privacy/requests/:id",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Privacy request status with a short-lived download link", params: idParams, response: { 200: dataEnvelope(privacyRequestSchema), ...standardErrors } },
    },
    async (request) => ({ data: await privacy.get(requireAuth(request).userId, request.params.id) }),
  );

  app.post(
    "/me/privacy/requests/:id/cancel",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Cancel a pending account deletion", params: idParams, response: { 200: dataEnvelope(privacyRequestSchema), ...standardErrors } },
    },
    async (request) => ({ data: await privacy.cancel(requireAuth(request).userId, request.params.id, requestMeta(request)) }),
  );

  app.get(
    "/admin/privacy-requests",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Administration"],
        security,
        summary: "Privacy requests across the platform",
        querystring: offsetQuery.extend({ type: z.enum(PrivacyRequestType).optional(), status: z.enum(PrivacyRequestStatus).optional() }).strict(),
        response: { 200: offsetPage(privacyRequestSchema.extend({ userId: z.uuid() })), ...standardErrors },
      },
    },
    async (request) => privacy.adminList(requireAuth(request).userId, request.query),
  );
}
