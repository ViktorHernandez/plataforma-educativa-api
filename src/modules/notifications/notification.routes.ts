import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { requireAuth } from "../../core/http/request-context.js";
import { cursorPage, cursorQuery, dataEnvelope, idParams, isoDateTime, okResponse, standardErrors } from "../../core/http/schemas.js";
import { resolveLocale } from "../../core/i18n/translator.js";
import { NotificationCategory } from "../../generated/prisma/enums.js";

const tags = ["Notifications"];
const security = [{ bearerAuth: [] }];

export const presentedNotification = z.object({
  id: z.uuid(),
  category: z.enum(NotificationCategory),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  target: z.object({ kind: z.string(), id: z.string(), parentId: z.string().optional() }).nullable(),
  readAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});

export function registerNotificationRoutes(app: AppInstance, container: Container): void {
  const { notifications, authenticator, users } = container;

  app.get(
    "/me/notifications",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Activity center",
        querystring: cursorQuery.extend({ unreadOnly: z.stringbool().default(false), category: z.enum(NotificationCategory).optional() }).strict(),
        response: { 200: cursorPage(presentedNotification), ...standardErrors },
      },
    },
    async (request) => {
      const current = requireAuth(request);
      const preferences = await users.preferences(current.userId);
      return notifications.list(current.userId, resolveLocale(preferences.locale, request.locale), request.query);
    },
  );

  app.get(
    "/me/notifications/unread-count",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Unread notifications", response: { 200: dataEnvelope(z.object({ unread: z.number().int() })), ...standardErrors } } },
    async (request) => ({ data: { unread: await notifications.unreadCount(requireAuth(request).userId) } }),
  );

  app.post(
    "/me/notifications/:id/read",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Mark as read", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await notifications.markRead(requireAuth(request).userId, request.params.id);
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/me/notifications/read-all",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Mark all as read", response: { 200: dataEnvelope(z.object({ updated: z.number().int() })), ...standardErrors } } },
    async (request) => ({ data: { updated: await notifications.markAllRead(requireAuth(request).userId) } }),
  );

  app.delete(
    "/me/notifications/:id",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Archive a notification", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await notifications.archive(requireAuth(request).userId, request.params.id);
      return { data: { ok: true as const } };
    },
  );
}
