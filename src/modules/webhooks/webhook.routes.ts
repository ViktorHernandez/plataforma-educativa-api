import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function registerWebhookRoutes(app: AppInstance, container: Container): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 256 * 1024 }, (_request, body, done) => done(null, body));

    scope.post(
      "/webhooks/email/resend",
      { schema: { tags: ["Webhooks"], summary: "Email delivery events signed with Svix", response: { 202: z.object({ data: z.object({ received: z.literal(true), duplicate: z.boolean() }) }) } } },
      async (request, reply) => {
        await container.rateLimits.consume("webhookIp", request.client.ip);
        const result = await container.webhooks.receiveResend(
          container.config.RESEND_WEBHOOK_SECRET,
          { id: header(request.headers["svix-id"]), timestamp: header(request.headers["svix-timestamp"]), signature: header(request.headers["svix-signature"]) },
          typeof request.body === "string" ? request.body : "",
        );
        reply.code(202);
        return { data: { received: true as const, duplicate: result.duplicate } };
      },
    );
  });
}
