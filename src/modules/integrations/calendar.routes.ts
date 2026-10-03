import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { acceptedResponse, dataEnvelope, idParams, isoDateTime, standardErrors } from "../../core/http/schemas.js";
import { oauthCallbackQuery } from "../auth/auth.schemas.js";

const tags = ["Integrations"];
const security = [{ bearerAuth: [] }];
const providerParams = z.object({ provider: z.enum(["google", "microsoft"]) }).strict();

export function registerCalendarRoutes(app: AppInstance, container: Container): void {
  const { calendar, authenticator } = container;

  app.get(
    "/integrations/calendar/providers",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Calendar providers available for synchronization",
        response: { 200: dataEnvelope(z.array(z.object({ slug: z.string(), provider: z.string(), enabled: z.boolean() }))), ...standardErrors },
      },
    },
    () => ({ data: calendar.providers() }),
  );

  app.post(
    "/me/integrations/calendar/:provider/connect",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Start the OAuth flow to connect a calendar",
        params: providerParams,
        response: { 200: dataEnvelope(z.object({ authorizationUrl: z.string(), expiresAt: isoDateTime })), ...standardErrors },
      },
    },
    async (request) => ({ data: await calendar.startConnect(requireAuth(request).userId, request.params.provider) }),
  );

  app.get(
    "/integrations/calendar/:provider/callback",
    { schema: { tags, summary: "OAuth redirect endpoint used by calendar providers", params: providerParams, querystring: oauthCallbackQuery } },
    async (request, reply) => {
      const location = await calendar.completeConnect(request.params.provider, request.query, requestMeta(request));
      reply.header("referrer-policy", "no-referrer");
      return reply.redirect(location, 302);
    },
  );

  app.post(
    "/me/integrations/:id/sync",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Queue a calendar synchronization", params: idParams, response: { 202: acceptedResponse, ...standardErrors } },
    },
    async (request, reply) => {
      await calendar.requestSync(requireAuth(request).userId, request.params.id, requestMeta(request));
      reply.code(202);
      return { data: { accepted: true as const } };
    },
  );
}
