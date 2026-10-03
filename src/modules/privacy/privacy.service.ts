import type { Logger } from "pino";
import type { AppConfig } from "../../config/env.js";
import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import type { AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database , Prisma } from "../../core/database/prisma.js";
import { isUniqueViolation } from "../../core/database/prisma.js";
import type { OutboxService } from "../../core/events/outbox.js";
import { ErrorCode, conflict, notFound } from "../../core/http/errors.js";
import { offsetMetaOf } from "../../core/http/pagination.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { EmailQueue } from "../../core/mail/email-queue.js";
import { EmailTemplate } from "../../core/mail/templates.js";
import { rooms, type RealtimeBus } from "../../core/realtime/realtime-bus.js";
import type { RateLimitService } from "../../core/security/rate-limiter.js";
import type { SessionStore } from "../../core/security/session-store.js";
import type { StorageProvider } from "../../core/storage/storage-provider.js";
import type { PrivacyRequest } from "../../generated/prisma/client.js";
import {
  ActorType,
  CertificateStatus,
  FilePurpose,
  FileScanStatus,
  FileStatus,
  FileVisibility,
  MembershipStatus,
  NotificationCategory,
  PrivacyRequestStatus,
  PrivacyRequestType,
  RoleScope,
  UserStatus,
} from "../../generated/prisma/enums.js";
import { NotificationType } from "../notifications/notification-catalog.js";
import type { NotificationService } from "../notifications/notification.service.js";
import { personalDataSections, personalDataStream, type ExportCounter } from "./personal-data-export.js";

export const PRIVACY_EXPORT_EVENT = "privacy.export";
export const PRIVACY_DELETION_EVENT = "privacy.deletion";

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const personalFilePurposes: FilePurpose[] = [FilePurpose.AVATAR, FilePurpose.MESSAGE_ATTACHMENT, FilePurpose.DATA_EXPORT, FilePurpose.REPORT_EXPORT];
const ERASED_NAME = "[redacted]";
const STALE_PROCESSING_MS = 30 * 60 * 1000;

export function erasedEmailFor(userId: string): string {
  return `erased+${userId}@invalid.invalid`;
}

export interface DeletionSummary {
  sessions: number;
  devices: number;
  notifications: number;
  activityEvents: number;
  messagesRedacted: number;
  conversationsLeft: number;
  filesDeleted: number;
  filesDetached: number;
  certificatesRevoked: number;
  integrations: number;
  identities: number;
  roleAssignments: number;
  membershipsRemoved: number;
  retained: string[];
}

export class PrivacyService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly storage: StorageProvider,
    private readonly emails: EmailQueue,
    private readonly notifications: NotificationService,
    private readonly sessionStore: SessionStore,
    private readonly realtime: RealtimeBus,
    private readonly rateLimits: RateLimitService,
    private readonly logger: Logger,
    private readonly urlTtlSeconds: number,
    private readonly exportBatchSize?: number,
  ) {}

  present(request: PrivacyRequest, downloadUrl: string | null = null) {
    return {
      id: request.id,
      type: request.type,
      status: request.status,
      requestedAt: request.requestedAt,
      scheduledFor: request.scheduledFor,
      completedAt: request.completedAt,
      cancelledAt: request.cancelledAt,
      expiresAt: request.expiresAt,
      error: request.error,
      downloadUrl,
      downloadUrlExpiresAt: downloadUrl ? new Date(Date.now() + this.urlTtlSeconds * 1000) : null,
    };
  }

  async requestExport(userId: string, meta: RequestMeta) {
    await this.rateLimits.consume("expensiveUser", userId);
    const active = await this.db.privacyRequest.findFirst({
      where: { userId, type: PrivacyRequestType.EXPORT, status: { in: [PrivacyRequestStatus.PENDING, PrivacyRequestStatus.PROCESSING] } },
    });
    if (active) return this.present(active);
    try {
      const created = await this.db.$transaction(async (tx) => {
        const request = await tx.privacyRequest.create({ data: { userId, type: PrivacyRequestType.EXPORT, requestId: meta.requestId } });
        await this.outbox.enqueue(tx, { type: PRIVACY_EXPORT_EVENT, aggregateType: "privacy_request", aggregateId: request.id, payload: { requestId: request.id }, requestId: meta.requestId });
        await this.audit.record({ action: "privacy.export.requested", category: AuditCategory.DATA, actorId: userId, resourceType: "privacy_request", resourceId: request.id, meta }, tx);
        return request;
      });
      return this.present(created);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const concurrent = await this.db.privacyRequest.findFirstOrThrow({
        where: { userId, type: PrivacyRequestType.EXPORT, status: { in: [PrivacyRequestStatus.PENDING, PrivacyRequestStatus.PROCESSING] } },
      });
      return this.present(concurrent);
    }
  }

  async generateExport(requestId: string): Promise<void> {
    const startedAt = new Date();
    const claimed = await this.db.privacyRequest.updateMany({
      where: {
        id: requestId,
        type: PrivacyRequestType.EXPORT,
        OR: [
          { status: PrivacyRequestStatus.PENDING },
          { status: PrivacyRequestStatus.PROCESSING, OR: [{ startedAt: null }, { startedAt: { lt: new Date(startedAt.getTime() - STALE_PROCESSING_MS) } }] },
        ],
      },
      data: { status: PrivacyRequestStatus.PROCESSING, startedAt },
    });
    if (claimed.count === 0) return;
    const request = await this.db.privacyRequest.findUniqueOrThrow({ where: { id: requestId }, include: { user: { include: { preference: true } } } });
    const objectKey = `data_export/${request.userId}/${request.id}.json`;
    const generatedAt = new Date();
    const counter: ExportCounter = { records: 0, sections: {} };
    try {
      const stream = personalDataStream(personalDataSections(this.db, request.userId), { userId: request.userId, generatedAt }, counter, this.exportBatchSize);
      const { sizeBytes } = await this.storage.putStream(objectKey, stream, "application/json");
      const expiresAt = new Date(generatedAt.getTime() + this.config.PRIVACY_EXPORT_TTL_HOURS * HOUR_MS);
      await this.db.$transaction(async (tx) => {
        const file = await tx.file.create({
          data: {
            ownerId: request.userId,
            purpose: FilePurpose.DATA_EXPORT,
            status: FileStatus.READY,
            scanStatus: FileScanStatus.NOT_REQUIRED,
            visibility: FileVisibility.PRIVATE,
            storageProvider: this.storage.name,
            objectKey,
            originalName: `personal-data-${generatedAt.toISOString().slice(0, 10)}.json`,
            mimeType: "application/json",
            declaredSizeBytes: BigInt(sizeBytes),
            sizeBytes: BigInt(sizeBytes),
            uploadedAt: generatedAt,
            readyAt: generatedAt,
            expiresAt,
          },
        });
        await tx.privacyRequest.update({
          where: { id: request.id },
          data: { status: PrivacyRequestStatus.COMPLETED, completedAt: new Date(), fileId: file.id, expiresAt, error: null, summary: { records: counter.records, sections: counter.sections, sizeBytes } },
        });
        await this.notifications.notify(tx, {
          userId: request.userId,
          category: NotificationCategory.SECURITY,
          type: NotificationType.PrivacyExportReady,
          target: { kind: "privacy_request", id: request.id },
          requestId: request.requestId,
        });
        await this.emails.enqueue(tx, {
          template: EmailTemplate.PrivacyExportReady,
          to: request.user.email,
          userId: request.userId,
          locale: request.user.preference?.locale ?? "es",
          timezone: request.user.preference?.timezone,
          values: { name: request.user.displayName, hours: this.config.PRIVACY_EXPORT_TTL_HOURS },
          actionUrl: new URL("/settings/privacy", this.config.WEB_APP_URL).toString(),
          requestId: request.requestId,
        });
        await this.audit.record(
          {
            action: "privacy.export.completed",
            category: AuditCategory.DATA,
            actorId: request.userId,
            actorType: ActorType.SYSTEM,
            resourceType: "privacy_request",
            resourceId: request.id,
            metadata: { records: counter.records, sizeBytes },
          },
          tx,
        );
      });
    } catch (error) {
      await this.storage.delete(objectKey).catch(() => undefined);
      await this.db.privacyRequest.update({ where: { id: request.id }, data: { status: PrivacyRequestStatus.FAILED, error: (error instanceof Error ? error.message : "failed").slice(0, 1000) } });
      throw error;
    }
  }

  async list(userId: string) {
    const requests = await this.db.privacyRequest.findMany({ where: { userId }, orderBy: { requestedAt: "desc" }, take: 50 });
    return requests.map((request) => this.present(request));
  }

  async get(userId: string, requestId: string) {
    const request = await this.db.privacyRequest.findFirst({ where: { id: requestId, userId }, include: { file: true } });
    if (!request) throw notFound("Privacy request");
    const available =
      request.type === PrivacyRequestType.EXPORT &&
      request.status === PrivacyRequestStatus.COMPLETED &&
      request.file !== null &&
      request.file.ownerId === userId &&
      request.file.status === FileStatus.READY &&
      (request.expiresAt === null || request.expiresAt > new Date());
    const url = available
      ? await this.storage.createDownloadUrl(request.file!.objectKey, { fileName: request.file!.originalName, contentType: request.file!.mimeType, expiresInSeconds: this.urlTtlSeconds })
      : null;
    if (url) {
      await this.audit.record({ action: "privacy.export.download_issued", category: AuditCategory.DATA, actorId: userId, resourceType: "privacy_request", resourceId: request.id });
    }
    return this.present(request, url);
  }

  async requestDeletion(userId: string, meta: RequestMeta) {
    await this.rateLimits.consume("sensitiveUser", userId);
    const platformRoles = await this.db.roleAssignment.count({ where: { userId, scopeType: RoleScope.PLATFORM } });
    if (platformRoles > 0) throw conflict(ErrorCode.BUSINESS_RULE, "Platform administrators must hand over their role before deleting the account");
    const existing = await this.db.privacyRequest.findFirst({
      where: { userId, type: PrivacyRequestType.DELETION, status: { in: [PrivacyRequestStatus.PENDING, PrivacyRequestStatus.PROCESSING] } },
    });
    if (existing) return this.present(existing);
    const scheduledFor = new Date(Date.now() + this.config.PRIVACY_DELETION_GRACE_DAYS * DAY_MS);
    try {
      const created = await this.db.$transaction(async (tx) => {
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, include: { preference: true } });
        const request = await tx.privacyRequest.create({ data: { userId, type: PrivacyRequestType.DELETION, scheduledFor, requestId: meta.requestId } });
        await this.outbox.enqueue(tx, {
          type: PRIVACY_DELETION_EVENT,
          aggregateType: "privacy_request",
          aggregateId: request.id,
          payload: { requestId: request.id },
          availableAt: scheduledFor,
          requestId: meta.requestId,
        });
        await this.emails.enqueue(tx, {
          template: EmailTemplate.PrivacyDeletionScheduled,
          to: user.email,
          userId,
          locale: user.preference?.locale ?? "es",
          timezone: user.preference?.timezone,
          values: { name: user.displayName },
          dateValues: { date: scheduledFor.toISOString() },
          actionUrl: new URL("/settings/privacy", this.config.WEB_APP_URL).toString(),
          requestId: meta.requestId,
        });
        await this.audit.record(
          { action: "privacy.deletion.requested", category: AuditCategory.DATA, actorId: userId, resourceType: "privacy_request", resourceId: request.id, metadata: { scheduledFor: scheduledFor.toISOString() }, meta },
          tx,
        );
        return request;
      });
      return this.present(created);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const concurrent = await this.db.privacyRequest.findFirstOrThrow({
        where: { userId, type: PrivacyRequestType.DELETION, status: { in: [PrivacyRequestStatus.PENDING, PrivacyRequestStatus.PROCESSING] } },
      });
      return this.present(concurrent);
    }
  }

  async cancel(userId: string, requestId: string, meta: RequestMeta) {
    const cancelled = await this.db.privacyRequest.updateMany({
      where: { id: requestId, userId, type: PrivacyRequestType.DELETION, status: PrivacyRequestStatus.PENDING },
      data: { status: PrivacyRequestStatus.CANCELLED, cancelledAt: new Date() },
    });
    if (cancelled.count === 0) {
      const exists = await this.db.privacyRequest.findFirst({ where: { id: requestId, userId } });
      if (!exists) throw notFound("Privacy request");
      throw conflict(ErrorCode.BUSINESS_RULE, "Only pending deletion requests can be cancelled");
    }
    await this.audit.record({ action: "privacy.deletion.cancelled", category: AuditCategory.DATA, actorId: userId, resourceType: "privacy_request", resourceId: requestId, meta });
    return this.present(await this.db.privacyRequest.findUniqueOrThrow({ where: { id: requestId } }));
  }

  async executeDeletion(requestId: string, now = new Date()): Promise<DeletionSummary | null> {
    const claimed = await this.db.privacyRequest.updateMany({
      where: { id: requestId, type: PrivacyRequestType.DELETION, status: PrivacyRequestStatus.PENDING, scheduledFor: { lte: now } },
      data: { status: PrivacyRequestStatus.PROCESSING, startedAt: now },
    });
    if (claimed.count === 0) return null;
    const request = await this.db.privacyRequest.findUniqueOrThrow({ where: { id: requestId }, include: { user: { include: { preference: true } } } });
    const userId = request.userId;
    try {
      const sessionIds = (await this.db.session.findMany({ where: { userId }, select: { id: true } })).map((session) => session.id);
      const objectKeys: string[] = [];
      const summary = await this.db.$transaction(
        async (tx) => {
          const personalFiles = await tx.file.findMany({ where: { ownerId: userId, purpose: { in: personalFilePurposes }, deletedAt: null }, select: { id: true, objectKey: true, quarantineKey: true } });
          for (const file of personalFiles) {
            objectKeys.push(file.objectKey);
            if (file.quarantineKey) objectKeys.push(file.quarantineKey);
          }
          const filesDeleted = await tx.file.updateMany({
            where: { id: { in: personalFiles.map((file) => file.id) } },
            data: { status: FileStatus.DELETED, deletedAt: now, ownerId: null, originalName: "deleted", altText: null },
          });
          const filesDetached = await tx.file.updateMany({ where: { ownerId: userId }, data: { ownerId: null } });
          await tx.messageAttachment.deleteMany({ where: { message: { senderId: userId } } });
          const messagesRedacted = await tx.message.updateMany({ where: { senderId: userId }, data: { body: "", deletedAt: now, senderId: null, clientMessageId: null } });
          const conversationsLeft = await tx.conversationParticipant.deleteMany({ where: { userId } });
          const notifications = await tx.notification.deleteMany({ where: { userId } });
          const activityEvents = await tx.activityEvent.deleteMany({ where: { userId } });
          await tx.notificationPreference.deleteMany({ where: { userId } });
          const integrations = await tx.integrationConnection.deleteMany({ where: { userId } });
          const identities = await tx.externalIdentity.deleteMany({ where: { userId } });
          await tx.pushSubscription.deleteMany({ where: { userId } });
          await tx.mfaFactor.deleteMany({ where: { userId } });
          await tx.recoveryCode.deleteMany({ where: { userId } });
          await tx.verificationToken.deleteMany({ where: { userId } });
          await tx.loginChallenge.deleteMany({ where: { userId } });
          const sessions = await tx.session.deleteMany({ where: { userId } });
          const devices = await tx.userDevice.deleteMany({ where: { userId } });
          const roleAssignments = await tx.roleAssignment.deleteMany({ where: { userId } });
          const membershipsRemoved = await tx.institutionMembership.updateMany({ where: { userId, status: { not: MembershipStatus.REMOVED } }, data: { status: MembershipStatus.REMOVED } });
          await tx.userProfile.deleteMany({ where: { userId } });
          await tx.userPreference.deleteMany({ where: { userId } });
          const certificates = await tx.certificate.findMany({ where: { userId }, select: { id: true, snapshot: true } });
          for (const certificate of certificates) {
            const snapshot = { ...(certificate.snapshot as Record<string, unknown>), learnerName: ERASED_NAME };
            await tx.certificate.update({
              where: { id: certificate.id },
              data: { status: CertificateStatus.REVOKED, revokedAt: now, revokedReason: "SUBJECT_ERASURE", snapshot: snapshot },
            });
          }
          await tx.privacyRequest.updateMany({ where: { userId, type: PrivacyRequestType.EXPORT }, data: { fileId: null } });
          await tx.user.update({
            where: { id: userId },
            data: {
              email: erasedEmailFor(userId),
              displayName: ERASED_NAME,
              passwordHash: null,
              passwordChangedAt: null,
              emailVerifiedAt: null,
              mfaEnabled: false,
              lastLoginAt: null,
              suspendedReason: null,
              status: UserStatus.DEACTIVATED,
              deletedAt: now,
              anonymizedAt: now,
            },
          });
          const result: DeletionSummary = {
            sessions: sessions.count,
            devices: devices.count,
            notifications: notifications.count,
            activityEvents: activityEvents.count,
            messagesRedacted: messagesRedacted.count,
            conversationsLeft: conversationsLeft.count,
            filesDeleted: filesDeleted.count,
            filesDetached: filesDetached.count,
            certificatesRevoked: certificates.length,
            integrations: integrations.count,
            identities: identities.count,
            roleAssignments: roleAssignments.count,
            membershipsRemoved: membershipsRemoved.count,
            retained: ["enrollments", "lessonProgress", "assessmentAttempts", "assessmentResults", "accommodations", "certificates", "auditLogs", "institutionContentFiles"],
          };
          await tx.privacyRequest.update({ where: { id: request.id }, data: { status: PrivacyRequestStatus.COMPLETED, completedAt: new Date(), summary: result as unknown as Prisma.InputJsonValue } });
          await this.emails.enqueue(tx, {
            template: EmailTemplate.PrivacyDeletionCompleted,
            to: request.user.email,
            locale: request.user.preference?.locale ?? "es",
            values: {},
            requestId: request.requestId,
          });
          await this.audit.record(
            {
              action: "privacy.deletion.completed",
              category: AuditCategory.DATA,
              actorId: userId,
              actorType: ActorType.SYSTEM,
              resourceType: "privacy_request",
              resourceId: request.id,
              metadata: { summary: result },
            },
            tx,
          );
          return result;
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
      await this.sessionStore.invalidate(sessionIds);
      await this.authz.invalidate(userId);
      await this.realtime.disconnect(rooms.user(userId), "account_deleted");
      for (const key of objectKeys) {
        await this.storage.delete(key).catch((error: unknown) => this.logger.warn({ err: error }, "failed to delete personal file from storage"));
      }
      return summary;
    } catch (error) {
      await this.db.privacyRequest.update({ where: { id: request.id }, data: { status: PrivacyRequestStatus.PENDING, startedAt: null, error: (error instanceof Error ? error.message : "failed").slice(0, 1000) } });
      throw error;
    }
  }

  async processDueDeletions(now = new Date(), limit = 20): Promise<number> {
    const due = await this.db.privacyRequest.findMany({
      where: { type: PrivacyRequestType.DELETION, status: PrivacyRequestStatus.PENDING, scheduledFor: { lte: now } },
      orderBy: { scheduledFor: "asc" },
      take: limit,
      select: { id: true },
    });
    let processed = 0;
    for (const item of due) {
      try {
        if (await this.executeDeletion(item.id, now)) processed += 1;
      } catch (error) {
        this.logger.error({ err: error, privacyRequestId: item.id }, "scheduled deletion failed");
      }
    }
    return processed;
  }

  async adminList(actorId: string, query: { page: number; pageSize: number; type?: PrivacyRequestType; status?: PrivacyRequestStatus }) {
    await this.authz.require(actorId, Permission.PrivacyManage);
    const where: Prisma.PrivacyRequestWhereInput = { ...(query.type ? { type: query.type } : {}), ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await Promise.all([
      this.db.privacyRequest.findMany({ where, orderBy: { requestedAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.privacyRequest.count({ where }),
    ]);
    return { data: items.map((item) => ({ ...this.present(item), userId: item.userId })), meta: offsetMetaOf(query.page, query.pageSize, total) };
  }
}
