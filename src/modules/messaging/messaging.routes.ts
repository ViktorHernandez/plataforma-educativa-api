import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { cursorPage, cursorQuery, dataEnvelope, idParams, isoDateTime, okResponse, standardErrors, trimmedString } from "../../core/http/schemas.js";
import { ConversationType, ParticipantRole } from "../../generated/prisma/enums.js";

const security = [{ bearerAuth: [] }];
const tags = ["Messaging"];

const conversationSchema = z.object({
  id: z.uuid(),
  type: z.enum(ConversationType),
  title: z.string().nullable(),
  courseId: z.uuid().nullable(),
  institutionId: z.uuid().nullable(),
  lastMessageAt: isoDateTime.nullable(),
  unreadCount: z.number().int(),
  muted: z.boolean(),
  lastMessage: z.object({ id: z.uuid(), senderId: z.uuid().nullable(), preview: z.string(), createdAt: isoDateTime }).nullable(),
  participants: z.array(z.object({ userId: z.uuid(), displayName: z.string(), avatarFileId: z.uuid().nullable(), role: z.enum(ParticipantRole) })),
});

const messageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  sender: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  body: z.string(),
  deleted: z.boolean(),
  attachmentFileIds: z.array(z.uuid()),
  clientMessageId: z.string().nullable(),
  createdAt: isoDateTime,
  editedAt: isoDateTime.nullable(),
});

export function registerMessagingRoutes(app: AppInstance, container: Container): void {
  const { messaging, authenticator } = container;

  app.get(
    "/conversations",
    { preHandler: authenticator.required, schema: { tags, security, summary: "My conversations", querystring: cursorQuery.strict(), response: { 200: cursorPage(conversationSchema), ...standardErrors } } },
    async (request) => messaging.list(requireAuth(request).userId, request.query),
  );

  app.post(
    "/conversations/direct",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Open a direct conversation", body: z.object({ userId: z.uuid() }).strict(), response: { 200: dataEnvelope(conversationSchema), ...standardErrors } },
    },
    async (request) => ({ data: await messaging.openDirect(requireAuth(request).userId, request.body.userId) }),
  );

  app.post(
    "/conversations/groups",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Create a group conversation",
        body: z.object({ institutionId: z.uuid(), title: trimmedString(2, 160), participantIds: z.array(z.uuid()).min(1).max(200) }).strict(),
        response: { 201: dataEnvelope(conversationSchema), ...standardErrors },
      },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await messaging.createGroup(requireAuth(request).userId, request.body, requestMeta(request)) };
    },
  );

  app.post(
    "/courses/:id/conversation",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Join the course discussion", params: idParams, response: { 200: dataEnvelope(conversationSchema), ...standardErrors } } },
    async (request) => ({ data: await messaging.openCourseConversation(requireAuth(request).userId, request.params.id) }),
  );

  app.get(
    "/conversations/:id/messages",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Messages, newest first", params: idParams, querystring: cursorQuery.strict(), response: { 200: cursorPage(messageSchema), ...standardErrors } } },
    async (request) => messaging.messages(requireAuth(request).userId, request.params.id, request.query),
  );

  app.post(
    "/conversations/:id/messages",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Send a message (clientMessageId makes retries safe)",
        params: idParams,
        body: z
          .object({
            body: z.string().max(8000),
            clientMessageId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
            attachmentFileIds: z.array(z.uuid()).max(10).optional(),
          })
          .strict(),
        response: { 201: dataEnvelope(messageSchema), ...standardErrors },
      },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await messaging.send(requireAuth(request).userId, request.params.id, request.body, requestMeta(request)) };
    },
  );

  app.patch(
    "/messages/:id",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Edit my message", params: idParams, body: z.object({ body: trimmedString(1, 8000) }).strict(), response: { 200: dataEnvelope(messageSchema), ...standardErrors } },
    },
    async (request) => ({ data: await messaging.edit(requireAuth(request).userId, request.params.id, request.body.body) }),
  );

  app.delete(
    "/messages/:id",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Delete a message", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await messaging.remove(requireAuth(request).userId, request.params.id, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/conversations/:id/read",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Mark as read", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await messaging.markRead(requireAuth(request).userId, request.params.id);
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/conversations/:id/mute",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Mute or unmute", params: idParams, body: z.object({ until: isoDateTime.nullable() }).strict(), response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      await messaging.mute(requireAuth(request).userId, request.params.id, request.body.until);
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/conversations/:id/leave",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Leave a group conversation", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await messaging.leave(requireAuth(request).userId, request.params.id);
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/conversations/:id/participants",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Add participants to a group",
        params: idParams,
        body: z.object({ userIds: z.array(z.uuid()).min(1).max(200) }).strict(),
        response: { 200: dataEnvelope(conversationSchema), ...standardErrors },
      },
    },
    async (request) => ({ data: await messaging.addParticipants(requireAuth(request).userId, request.params.id, request.body.userIds) }),
  );
}
