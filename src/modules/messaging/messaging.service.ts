import type { Redis } from "ioredis";
import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import type { AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import { isUniqueViolation } from "../../core/database/prisma.js";
import { AppError, ErrorCode, badRequest, conflict, forbidden, notFound } from "../../core/http/errors.js";
import { buildCursorPage, decodeCursor } from "../../core/http/pagination.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import { rooms, type RealtimeBus } from "../../core/realtime/realtime-bus.js";
import type { RedisKeys } from "../../core/redis/redis.js";
import type { RateLimitService } from "../../core/security/rate-limiter.js";
import type { Conversation, Prisma } from "../../generated/prisma/client.js";
import { ConversationType, EnrollmentStatus, FilePurpose, FileStatus, MembershipStatus, NotificationCategory, ParticipantRole } from "../../generated/prisma/enums.js";
import type { PlatformSettingsService } from "../admin/platform-settings.service.js";
import type { CourseAccessService } from "../courses/course-access.service.js";
import { NotificationType } from "../notifications/notification-catalog.js";
import type { NotificationService } from "../notifications/notification.service.js";
import type { UserService } from "../users/user.service.js";

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const MESSAGE_NOTIFICATION_THROTTLE_SECONDS = 600;
const MAX_SUMMARY_PARTICIPANTS = 50;

type MessageWithRelations = Prisma.MessageGetPayload<{ include: { attachments: { select: { fileId: true } }; sender: { select: { id: true; displayName: true } } } }>;

export class MessagingService {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly keys: RedisKeys,
    private readonly authz: AuthorizationService,
    private readonly access: CourseAccessService,
    private readonly users: UserService,
    private readonly settings: PlatformSettingsService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimeBus,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
  ) {}

  async isParticipant(conversationId: string, userId: string): Promise<boolean> {
    const participant = await this.db.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId } }, select: { leftAt: true } });
    return participant !== null && participant.leftAt === null;
  }

  private async retainsConversationAccess(userId: string, conversation: Pick<Conversation, "type" | "institutionId" | "courseId">): Promise<boolean> {
    if (conversation.type === ConversationType.COURSE && conversation.courseId) {
      const course = await this.db.course.findFirst({ where: { id: conversation.courseId, deletedAt: null }, select: { id: true, institutionId: true } });
      if (!course) return false;
      if (await this.access.can(userId, Permission.CourseRead, course)) return true;
      return (await this.access.learnerEnrollment(userId, course.id)) !== null;
    }
    if (conversation.type === ConversationType.GROUP && conversation.institutionId) {
      if (await this.authz.can(userId, Permission.MessagingModerate, { institutionId: conversation.institutionId })) return true;
      return this.access.isInstitutionMember(userId, conversation.institutionId);
    }
    return true;
  }

  async canAccessConversation(userId: string, conversationId: string): Promise<boolean> {
    const conversation = await this.db.conversation.findUnique({ where: { id: conversationId }, select: { type: true, institutionId: true, courseId: true } });
    if (!conversation || !(await this.isParticipant(conversationId, userId))) return false;
    return this.retainsConversationAccess(userId, conversation);
  }

  private async requireParticipant(conversationId: string, userId: string) {
    const conversation = await this.db.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || !(await this.isParticipant(conversationId, userId)) || !(await this.retainsConversationAccess(userId, conversation))) throw notFound("Conversation");
    return conversation;
  }

  private async isStaffForLearner(staffId: string, learnerId: string): Promise<boolean> {
    const enrollments = await this.db.enrollment.findMany({
      where: { userId: learnerId, status: { in: [EnrollmentStatus.ACTIVE, EnrollmentStatus.COMPLETED] } },
      select: { courseId: true, institutionId: true },
      take: 200,
    });
    for (const enrollment of enrollments) {
      if (await this.authz.can(staffId, Permission.CourseRead, { institutionId: enrollment.institutionId, courseId: enrollment.courseId })) return true;
    }
    return false;
  }

  private async assertCanMessage(senderId: string, recipientId: string): Promise<void> {
    if (senderId === recipientId) throw badRequest(ErrorCode.VALIDATION_FAILED, "You cannot message yourself");
    const recipient = await this.db.user.findFirst({ where: { id: recipientId, status: "ACTIVE", deletedAt: null }, select: { id: true } });
    if (!recipient) throw notFound("User");
    if (!(await this.acceptsMessagesFrom(senderId, recipientId))) throw forbidden("This user does not accept direct messages from you");
  }

  private async acceptsMessagesFrom(senderId: string, recipientId: string): Promise<boolean> {
    const privacy = await this.users.privacyOf(recipientId);
    const senderIsStaff = await this.isStaffForLearner(senderId, recipientId);
    const recipientIsStaff = await this.isStaffForLearner(recipientId, senderId);
    const sharesInstitution = await this.users.sharesActiveInstitution(senderId, recipientId);
    let allowed: boolean;
    switch (privacy.allowDirectMessages) {
      case "nobody":
        allowed = senderIsStaff;
        break;
      case "staff_only":
        allowed = senderIsStaff;
        break;
      case "institution":
        allowed = sharesInstitution || senderIsStaff || recipientIsStaff;
        break;
      default:
        allowed = true;
    }
    if (allowed && !senderIsStaff && !recipientIsStaff && !(await this.settings.get("messaging.studentDirectMessages"))) allowed = false;
    return allowed;
  }

  private async assertCanAddToGroup(actorId: string, institutionId: string, userIds: string[]): Promise<void> {
    const members = await this.db.institutionMembership.count({ where: { institutionId, userId: { in: userIds }, status: MembershipStatus.ACTIVE } });
    if (members !== userIds.length) throw badRequest(ErrorCode.BUSINESS_RULE, "Every participant must be an active member of the institution");
    if (await this.authz.can(actorId, Permission.InstitutionMembersRead, { institutionId })) return;
    for (const userId of userIds) {
      if (!(await this.acceptsMessagesFrom(actorId, userId))) throw forbidden("A participant does not accept messages from you");
    }
  }

  async openDirect(senderId: string, recipientId: string) {
    await this.assertCanMessage(senderId, recipientId);
    const directKey = [senderId, recipientId].sort().join(":");
    const existing = await this.db.conversation.findUnique({ where: { directKey } });
    if (existing) {
      await this.db.conversationParticipant.updateMany({ where: { conversationId: existing.id, userId: senderId, leftAt: { not: null } }, data: { leftAt: null } });
      return this.conversationSummary(existing.id, senderId);
    }
    try {
      const created = await this.db.conversation.create({
        data: {
          type: ConversationType.DIRECT,
          directKey,
          createdById: senderId,
          participants: { create: [{ userId: senderId, role: ParticipantRole.MEMBER }, { userId: recipientId, role: ParticipantRole.MEMBER }] },
        },
      });
      return this.conversationSummary(created.id, senderId);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrent = await this.db.conversation.findUniqueOrThrow({ where: { directKey } });
        return this.conversationSummary(concurrent.id, senderId);
      }
      throw error;
    }
  }

  async createGroup(creatorId: string, input: { institutionId: string; title: string; participantIds: string[] }, meta: RequestMeta) {
    const participantIds = [...new Set(input.participantIds.filter((id) => id !== creatorId))];
    if (!(await this.access.isInstitutionMember(creatorId, input.institutionId))) throw badRequest(ErrorCode.BUSINESS_RULE, "Every participant must be an active member of the institution");
    await this.assertCanAddToGroup(creatorId, input.institutionId, participantIds);
    const conversation = await this.db.conversation.create({
      data: {
        type: ConversationType.GROUP,
        institutionId: input.institutionId,
        title: input.title,
        createdById: creatorId,
        participants: { create: [{ userId: creatorId, role: ParticipantRole.OWNER }, ...participantIds.map((userId) => ({ userId, role: ParticipantRole.MEMBER }))] },
      },
    });
    await this.audit.record({ action: "conversation.group.created", category: AuditCategory.DATA, actorId: creatorId, resourceType: "conversation", resourceId: conversation.id, institutionId: input.institutionId, meta });
    return this.conversationSummary(conversation.id, creatorId);
  }

  async openCourseConversation(actorId: string, courseId: string) {
    const course = await this.access.findCourse(courseId);
    const staff = await this.access.can(actorId, Permission.CourseRead, course);
    if (!staff && !(await this.access.learnerEnrollment(actorId, courseId))) throw notFound("Course");
    let conversation = await this.db.conversation.findFirst({ where: { type: ConversationType.COURSE, courseId } });
    if (!conversation) {
      if (!staff) throw notFound("Conversation");
      conversation = await this.db.conversation.create({
        data: { type: ConversationType.COURSE, courseId, institutionId: course.institutionId, title: course.title, createdById: actorId, participants: { create: { userId: actorId, role: ParticipantRole.OWNER } } },
      });
    }
    await this.db.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId: conversation.id, userId: actorId } },
      create: { conversationId: conversation.id, userId: actorId, role: staff ? ParticipantRole.ADMIN : ParticipantRole.MEMBER },
      update: { leftAt: null },
    });
    return this.conversationSummary(conversation.id, actorId);
  }

  async conversationSummary(conversationId: string, userId: string) {
    const [summary] = await this.conversationSummaries([conversationId], userId);
    if (!summary) throw notFound("Conversation");
    return summary;
  }

  private async conversationSummaries(conversationIds: string[], userId: string) {
    if (conversationIds.length === 0) return [];
    const [conversations, memberships, participants, lastMessages, unreadCounts] = await Promise.all([
      this.db.conversation.findMany({ where: { id: { in: conversationIds } } }),
      this.db.conversationParticipant.findMany({ where: { conversationId: { in: conversationIds }, userId }, select: { conversationId: true, lastReadAt: true, mutedUntil: true } }),
      this.db.$queryRaw<Array<{ conversationId: string; userId: string; role: ParticipantRole; displayName: string; avatarFileId: string | null }>>`
        SELECT ranked."conversationId"::text AS "conversationId", ranked."userId"::text AS "userId", ranked."role"::text AS "role",
               u."displayName" AS "displayName", profile."avatarFileId"::text AS "avatarFileId"
        FROM (
          SELECT p."conversationId", p."userId", p."role", p."joinedAt",
                 row_number() OVER (PARTITION BY p."conversationId" ORDER BY p."joinedAt", p."userId") AS position
          FROM "conversation_participants" p
          WHERE p."conversationId" = ANY(${conversationIds}::uuid[]) AND p."leftAt" IS NULL
        ) ranked
        JOIN "users" u ON u."id" = ranked."userId"
        LEFT JOIN "user_profiles" profile ON profile."userId" = ranked."userId"
        WHERE ranked.position <= ${MAX_SUMMARY_PARTICIPANTS}
        ORDER BY ranked."conversationId", ranked.position`,
      this.db.$queryRaw<Array<{ conversationId: string; id: string; body: string; senderId: string | null; createdAt: Date }>>`
        SELECT DISTINCT ON (m."conversationId") m."conversationId"::text AS "conversationId", m."id"::text AS "id", m."body", m."senderId"::text AS "senderId", m."createdAt"
        FROM "messages" m
        WHERE m."conversationId" = ANY(${conversationIds}::uuid[]) AND m."deletedAt" IS NULL
        ORDER BY m."conversationId", m."id" DESC`,
      this.db.$queryRaw<Array<{ conversationId: string; unread: bigint }>>`
        SELECT m."conversationId"::text AS "conversationId", count(*) AS "unread"
        FROM "messages" m
        JOIN "conversation_participants" me ON me."conversationId" = m."conversationId" AND me."userId" = ${userId}::uuid
        WHERE m."conversationId" = ANY(${conversationIds}::uuid[])
          AND m."deletedAt" IS NULL
          AND m."senderId" <> ${userId}::uuid
          AND (me."lastReadAt" IS NULL OR m."createdAt" > me."lastReadAt")
        GROUP BY m."conversationId"`,
    ]);
    const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    const membershipOf = new Map(memberships.map((membership) => [membership.conversationId, membership]));
    const lastOf = new Map(lastMessages.map((message) => [message.conversationId, message]));
    const unreadOf = new Map(unreadCounts.map((row) => [row.conversationId, Number(row.unread)]));
    const participantsOf = new Map<string, typeof participants>();
    for (const participant of participants) {
      const list = participantsOf.get(participant.conversationId) ?? [];
      list.push(participant);
      participantsOf.set(participant.conversationId, list);
    }
    const now = new Date();
    return conversationIds.flatMap((id) => {
      const conversation = byId.get(id);
      if (!conversation) return [];
      const me = membershipOf.get(id);
      const last = lastOf.get(id);
      return [
        {
          id: conversation.id,
          type: conversation.type,
          title: conversation.title,
          courseId: conversation.courseId,
          institutionId: conversation.institutionId,
          lastMessageAt: conversation.lastMessageAt,
          unreadCount: unreadOf.get(id) ?? 0,
          muted: me?.mutedUntil ? me.mutedUntil > now : false,
          lastMessage: last ? { id: last.id, senderId: last.senderId, preview: last.body.slice(0, 140), createdAt: last.createdAt } : null,
          participants: (participantsOf.get(id) ?? []).map((participant) => ({
            userId: participant.userId,
            displayName: participant.displayName,
            avatarFileId: participant.avatarFileId,
            role: participant.role,
          })),
        },
      ];
    });
  }

  async list(userId: string, query: { cursor?: string; limit: number }) {
    const cursor = decodeCursor(query.cursor);
    const cursorDate = cursor?.sort !== undefined ? new Date(String(cursor.sort)) : null;
    if (cursorDate && Number.isNaN(cursorDate.getTime())) throw badRequest(ErrorCode.BAD_REQUEST, "Invalid cursor");
    const rows = await this.db.conversation.findMany({
      where: {
        participants: { some: { userId, leftAt: null } },
        ...(cursor && cursorDate ? { OR: [{ updatedAt: { lt: cursorDate } }, { updatedAt: cursorDate, id: { lt: cursor.id } }] } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      select: { id: true, updatedAt: true },
    });
    const page = buildCursorPage(rows, query.limit, (row) => row.updatedAt.toISOString());
    return { data: await this.conversationSummaries(page.data.map((row) => row.id), userId), meta: page.meta };
  }

  private presentMessage(message: MessageWithRelations) {
    return {
      id: message.id,
      conversationId: message.conversationId,
      sender: message.sender ? { id: message.sender.id, displayName: message.sender.displayName } : null,
      body: message.deletedAt ? "" : message.body,
      deleted: message.deletedAt !== null,
      attachmentFileIds: message.deletedAt ? [] : message.attachments.map((item) => item.fileId),
      clientMessageId: message.clientMessageId,
      createdAt: message.createdAt,
      editedAt: message.editedAt,
    };
  }

  async messages(userId: string, conversationId: string, query: { cursor?: string; limit: number }) {
    await this.requireParticipant(conversationId, userId);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.db.message.findMany({
      where: { conversationId, ...(cursor ? { id: { lt: cursor.id } } : {}) },
      orderBy: { id: "desc" },
      take: query.limit + 1,
      include: { attachments: { select: { fileId: true } }, sender: { select: { id: true, displayName: true } } },
    });
    const page = buildCursorPage(rows, query.limit);
    return { data: page.data.map((row) => this.presentMessage(row)), meta: page.meta };
  }

  async send(userId: string, conversationId: string, input: { body: string; clientMessageId?: string; attachmentFileIds?: string[] }, meta: RequestMeta) {
    await this.rateLimits.consume("messageUser", userId);
    const conversation = await this.requireParticipant(conversationId, userId);
    const body = input.body.trim();
    const attachments = [...new Set(input.attachmentFileIds ?? [])];
    if (body.length === 0 && attachments.length === 0) throw badRequest(ErrorCode.VALIDATION_FAILED, "Message is empty");
    if (attachments.length > 0) {
      const owned = await this.db.file.count({ where: { id: { in: attachments }, ownerId: userId, purpose: FilePurpose.MESSAGE_ATTACHMENT, status: FileStatus.READY, deletedAt: null } });
      if (owned !== attachments.length) throw badRequest(ErrorCode.VALIDATION_FAILED, "Attachments must be your own ready files");
    }
    if (conversation.type === ConversationType.DIRECT) {
      const other = await this.db.conversationParticipant.findFirst({ where: { conversationId, userId: { not: userId } }, select: { userId: true } });
      if (other) await this.assertCanMessage(userId, other.userId);
    }
    if (input.clientMessageId) {
      const duplicate = await this.db.message.findUnique({
        where: { conversationId_senderId_clientMessageId: { conversationId, senderId: userId, clientMessageId: input.clientMessageId } },
        include: { attachments: { select: { fileId: true } }, sender: { select: { id: true, displayName: true } } },
      });
      if (duplicate) return this.presentMessage(duplicate);
    }
    const now = new Date();
    let message: MessageWithRelations;
    try {
      message = await this.db.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            conversationId,
            senderId: userId,
            body,
            clientMessageId: input.clientMessageId ?? null,
            attachments: { create: attachments.map((fileId) => ({ fileId })) },
          },
          include: { attachments: { select: { fileId: true } }, sender: { select: { id: true, displayName: true } } },
        });
        await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: now } });
        await tx.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId } }, data: { lastReadAt: now } });
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error) && input.clientMessageId) {
        const duplicate = await this.db.message.findUniqueOrThrow({
          where: { conversationId_senderId_clientMessageId: { conversationId, senderId: userId, clientMessageId: input.clientMessageId } },
          include: { attachments: { select: { fileId: true } }, sender: { select: { id: true, displayName: true } } },
        });
        return this.presentMessage(duplicate);
      }
      throw error;
    }
    const presented = this.presentMessage(message);
    await this.realtime.emit(rooms.conversation(conversationId), "message:new", presented);
    const recipients = await this.db.conversationParticipant.findMany({ where: { conversationId, leftAt: null, userId: { not: userId } }, select: { userId: true, mutedUntil: true } });
    for (const recipient of recipients) {
      await this.realtime.emit(rooms.user(recipient.userId), "conversation:updated", { conversationId, lastMessageAt: now });
      if (conversation.type !== ConversationType.DIRECT || (recipient.mutedUntil && recipient.mutedUntil > now)) continue;
      const throttleKey = this.keys.key("msg-notify", conversationId, recipient.userId);
      const first = await this.redis.set(throttleKey, "1", "EX", MESSAGE_NOTIFICATION_THROTTLE_SECONDS, "NX").catch(() => "OK");
      if (first !== "OK") continue;
      await this.notifications.notify(this.db, {
        userId: recipient.userId,
        category: NotificationCategory.COMMUNICATION,
        type: NotificationType.MessageReceived,
        params: { sender: message.sender?.displayName ?? "" },
        target: { kind: "conversation", id: conversationId },
        requestId: meta.requestId,
      });
    }
    return presented;
  }

  async edit(userId: string, messageId: string, body: string) {
    const message = await this.db.message.findUnique({ where: { id: messageId } });
    if (!message || message.deletedAt || !(await this.canAccessConversation(userId, message.conversationId))) throw notFound("Message");
    if (message.senderId !== userId) throw forbidden("Only the author can edit a message");
    if (Date.now() - message.createdAt.getTime() > EDIT_WINDOW_MS) throw conflict(ErrorCode.BUSINESS_RULE, "The edit window has expired");
    const updated = await this.db.message.update({
      where: { id: messageId },
      data: { body: body.trim(), editedAt: new Date() },
      include: { attachments: { select: { fileId: true } }, sender: { select: { id: true, displayName: true } } },
    });
    const presented = this.presentMessage(updated);
    await this.realtime.emit(rooms.conversation(message.conversationId), "message:updated", presented);
    return presented;
  }

  async remove(userId: string, messageId: string, meta: RequestMeta) {
    const message = await this.db.message.findUnique({ where: { id: messageId }, include: { conversation: true } });
    if (!message || !(await this.canAccessConversation(userId, message.conversationId))) throw notFound("Message");
    if (message.senderId !== userId) {
      const scope = { institutionId: message.conversation.institutionId, courseId: message.conversation.courseId };
      if (!scope.institutionId || !(await this.authz.can(userId, Permission.MessagingModerate, scope))) throw forbidden("Only the author or a moderator can delete a message");
      await this.audit.record({ action: "message.moderated", category: AuditCategory.ADMINISTRATION, actorId: userId, resourceType: "message", resourceId: messageId, institutionId: scope.institutionId, meta });
    }
    await this.db.message.update({ where: { id: messageId }, data: { deletedAt: new Date() } });
    await this.realtime.emit(rooms.conversation(message.conversationId), "message:deleted", { id: messageId, conversationId: message.conversationId });
  }

  async markRead(userId: string, conversationId: string) {
    await this.requireParticipant(conversationId, userId);
    const now = new Date();
    await this.db.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId } }, data: { lastReadAt: now } });
    await this.realtime.emit(rooms.conversation(conversationId), "conversation:read", { conversationId, userId, readAt: now });
  }

  async mute(userId: string, conversationId: string, until: Date | null) {
    await this.requireParticipant(conversationId, userId);
    await this.db.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId } }, data: { mutedUntil: until } });
  }

  async leave(userId: string, conversationId: string) {
    const conversation = await this.requireParticipant(conversationId, userId);
    if (conversation.type === ConversationType.DIRECT) throw conflict(ErrorCode.BUSINESS_RULE, "Direct conversations can be muted but not left");
    await this.db.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId } }, data: { leftAt: new Date() } });
  }

  async addParticipants(actorId: string, conversationId: string, userIds: string[]) {
    const conversation = await this.requireParticipant(conversationId, actorId);
    if (conversation.type !== ConversationType.GROUP || !conversation.institutionId) throw conflict(ErrorCode.BUSINESS_RULE, "Only group conversations accept new participants");
    const actor = await this.db.conversationParticipant.findUniqueOrThrow({ where: { conversationId_userId: { conversationId, userId: actorId } } });
    if (actor.role === ParticipantRole.MEMBER) throw forbidden("Only group owners and admins can add participants");
    const ids = [...new Set(userIds)].filter((id) => id !== actorId);
    await this.assertCanAddToGroup(actorId, conversation.institutionId, ids);
    for (const userId of ids) {
      await this.db.conversationParticipant.upsert({
        where: { conversationId_userId: { conversationId, userId } },
        create: { conversationId, userId },
        update: { leftAt: null },
      });
    }
    return this.conversationSummary(conversationId, actorId);
  }

  async assertCanJoinRealtime(userId: string, conversationId: string): Promise<void> {
    if (!(await this.canAccessConversation(userId, conversationId))) throw new AppError(404, ErrorCode.NOT_FOUND, "Conversation not found");
  }
}
