import { randomUUID } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import type { Logger } from "pino";
import { ScannerUnavailableError, type MalwareScanner } from "../../core/antivirus/malware-scanner.js";
import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import type { AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import type { OutboxService } from "../../core/events/outbox.js";
import { AppError, ErrorCode, badRequest, conflict, notFound } from "../../core/http/errors.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { RateLimitService } from "../../core/security/rate-limiter.js";
import type { StorageProvider } from "../../core/storage/storage-provider.js";
import type { File } from "../../generated/prisma/client.js";
import { AuditOutcome, FilePurpose, FileScanStatus, FileStatus, FileVisibility, MembershipStatus } from "../../generated/prisma/enums.js";
import type { CourseAccessService } from "../courses/course-access.service.js";
import { detectTextFormat, purposePolicies, sanitizeFileName } from "./file-policy.js";

const UPLOAD_URL_TTL_SECONDS = 900;
const SNIFF_BYTES = 4100;

export const FILE_SCAN_EVENT = "file.scan";

export const servableScanStatuses: FileScanStatus[] = [FileScanStatus.CLEAN, FileScanStatus.SKIPPED, FileScanStatus.NOT_REQUIRED];

export interface FileScanPolicy {
  maxScanBytes: number;
  scanRequired: boolean;
}

export function isServable(file: Pick<File, "status" | "scanStatus">): boolean {
  return file.status === FileStatus.READY && servableScanStatuses.includes(file.scanStatus);
}

export function quarantineKeyFor(objectKey: string): string {
  return `quarantine/${objectKey}`;
}

export function incomingKeyFor(objectKey: string): string {
  return `incoming/${objectKey}`;
}

export interface UploadRequest {
  purpose: FilePurpose;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  courseId?: string | null;
  institutionId?: string | null;
  altText?: string | null;
}

export class FileService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageProvider,
    private readonly authz: AuthorizationService,
    private readonly access: CourseAccessService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
    private readonly urlTtlSeconds: number,
    private readonly scanner: MalwareScanner,
    private readonly outbox: OutboxService,
    private readonly scanPolicy: FileScanPolicy,
    private readonly logger: Logger,
  ) {}

  private async resolveInstitution(userId: string, request: UploadRequest): Promise<string | null> {
    switch (request.purpose) {
      case FilePurpose.AVATAR:
        return null;
      case FilePurpose.COURSE_COVER:
      case FilePurpose.LESSON_MEDIA:
      case FilePurpose.LESSON_RESOURCE:
      case FilePurpose.CAPTION: {
        if (request.courseId) {
          const course = await this.access.requireManage(userId, request.courseId, Permission.CourseUpdate);
          return course.institutionId;
        }
        if (request.purpose === FilePurpose.COURSE_COVER && request.institutionId) {
          await this.authz.require(userId, Permission.CourseCreate, { institutionId: request.institutionId }, { hideAs: "Institution" });
          return request.institutionId;
        }
        throw badRequest(ErrorCode.VALIDATION_FAILED, "courseId is required for course files");
      }
      case FilePurpose.SUBMISSION: {
        if (!request.courseId) throw badRequest(ErrorCode.VALIDATION_FAILED, "courseId is required for submissions");
        const enrollment = await this.access.learnerEnrollment(userId, request.courseId);
        if (!enrollment) throw new AppError(403, ErrorCode.NOT_ENROLLED, "Active enrollment required");
        return enrollment.institutionId;
      }
      case FilePurpose.MESSAGE_ATTACHMENT: {
        if (!request.institutionId) return null;
        const membership = await this.db.institutionMembership.findUnique({ where: { institutionId_userId: { institutionId: request.institutionId, userId } } });
        if (membership?.status !== MembershipStatus.ACTIVE) throw notFound("Institution");
        return request.institutionId;
      }
      default:
        throw badRequest(ErrorCode.VALIDATION_FAILED, "This purpose cannot be uploaded by clients");
    }
  }

  async createUpload(userId: string, request: UploadRequest, meta: RequestMeta) {
    await this.rateLimits.consume("uploadUser", userId);
    const policy = purposePolicies[request.purpose];
    if (!policy.mimeTypes.includes(request.mimeType)) {
      throw badRequest(ErrorCode.FILE_REJECTED, "File type not allowed for this purpose", { allowed: policy.mimeTypes });
    }
    if (request.sizeBytes <= 0 || request.sizeBytes > policy.maxBytes) {
      throw badRequest(ErrorCode.FILE_REJECTED, "File size not allowed", { maxBytes: policy.maxBytes });
    }
    const institutionId = await this.resolveInstitution(userId, request);
    const now = new Date();
    const objectKey = `${request.purpose.toLowerCase()}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}`;
    const file = await this.db.file.create({
      data: {
        ownerId: userId,
        institutionId,
        purpose: request.purpose,
        visibility: policy.visibility,
        storageProvider: this.storage.name,
        objectKey,
        originalName: sanitizeFileName(request.fileName),
        mimeType: request.mimeType,
        declaredSizeBytes: BigInt(request.sizeBytes),
        altText: request.altText ?? null,
      },
    });
    const upload = await this.storage.createUploadTarget(incomingKeyFor(objectKey), request.mimeType, request.sizeBytes, UPLOAD_URL_TTL_SECONDS);
    await this.audit.record({ action: "file.upload_requested", category: AuditCategory.DATA, actorId: userId, resourceType: "file", resourceId: file.id, institutionId, metadata: { purpose: request.purpose, sizeBytes: request.sizeBytes }, meta });
    return { file: this.present(file), upload };
  }

  async complete(userId: string, fileId: string, meta: RequestMeta) {
    const file = await this.db.file.findFirst({ where: { id: fileId, ownerId: userId, deletedAt: null } });
    if (!file) throw notFound("File");
    if (file.status === FileStatus.READY) return this.present(file);
    if (file.status !== FileStatus.PENDING_UPLOAD) throw conflict(ErrorCode.BUSINESS_RULE, "File is not awaiting upload");
    const info = await this.promoteUpload(file.objectKey);
    if (!info) throw conflict(ErrorCode.BUSINESS_RULE, "The upload has not been received");
    const policy = purposePolicies[file.purpose];
    const reject = async (reason: string) => {
      await this.storage.delete(file.objectKey).catch(() => undefined);
      await this.storage.delete(incomingKeyFor(file.objectKey)).catch(() => undefined);
      await this.db.file.update({ where: { id: file.id }, data: { status: FileStatus.REJECTED, rejectedReason: reason, sizeBytes: BigInt(info.sizeBytes) } });
      await this.audit.record({ action: "file.rejected", category: AuditCategory.SECURITY, actorId: userId, resourceType: "file", resourceId: file.id, metadata: { reason }, meta });
      throw badRequest(ErrorCode.FILE_REJECTED, "The file was rejected", { reason });
    };
    if (info.sizeBytes > Number(file.declaredSizeBytes) || info.sizeBytes > policy.maxBytes || info.sizeBytes === 0) await reject("SIZE_MISMATCH");
    const sample = await this.storage.readPrefix(file.objectKey, SNIFF_BYTES);
    const detected = await fileTypeFromBuffer(sample);
    let effectiveMime: string | null;
    if (detected) {
      effectiveMime = detected.mime === file.mimeType && policy.mimeTypes.includes(detected.mime) ? detected.mime : null;
    } else {
      effectiveMime = detectTextFormat(sample, file.mimeType, policy);
    }
    if (!effectiveMime) await reject("CONTENT_TYPE_MISMATCH");
    const now = new Date();
    const isMedia = file.mimeType.startsWith("video/") || file.mimeType.startsWith("audio/");
    const oversized = info.sizeBytes > this.scanPolicy.maxScanBytes;
    if (this.scanner.enabled && oversized && (!isMedia || this.scanPolicy.scanRequired)) await reject("SCAN_SIZE_LIMIT");
    if (!this.scanner.enabled || oversized) {
      const claimed = await this.db.file.updateMany({
        where: { id: file.id, status: FileStatus.PENDING_UPLOAD },
        data: { status: FileStatus.READY, scanStatus: FileScanStatus.SKIPPED, sizeBytes: BigInt(info.sizeBytes), uploadedAt: now, readyAt: now },
      });
      const ready = await this.db.file.findUniqueOrThrow({ where: { id: file.id } });
      if (claimed.count !== 1) return this.present(ready);
      await this.audit.record({
        action: oversized && this.scanner.enabled ? "file.scan_skipped_oversize" : "file.ready",
        category: AuditCategory.DATA,
        actorId: userId,
        resourceType: "file",
        resourceId: file.id,
        institutionId: file.institutionId,
        metadata: { scan: "skipped", sizeBytes: info.sizeBytes },
        meta,
      });
      return this.present(ready);
    }
    const pending = await this.db.$transaction(async (tx) => {
      const claimed = await tx.file.updateMany({
        where: { id: file.id, status: FileStatus.PENDING_UPLOAD },
        data: { status: FileStatus.PROCESSING, scanStatus: FileScanStatus.PENDING, sizeBytes: BigInt(info.sizeBytes), uploadedAt: now },
      });
      const updated = await tx.file.findUniqueOrThrow({ where: { id: file.id } });
      if (claimed.count !== 1) return updated;
      await this.outbox.enqueue(tx, { type: FILE_SCAN_EVENT, aggregateType: "file", aggregateId: file.id, payload: { fileId: file.id }, requestId: meta.requestId });
      await this.audit.record(
        { action: "file.scan_queued", category: AuditCategory.DATA, actorId: userId, resourceType: "file", resourceId: file.id, institutionId: file.institutionId, meta },
        tx,
      );
      return updated;
    });
    return this.present(pending);
  }

  private async promoteUpload(objectKey: string) {
    const incomingKey = incomingKeyFor(objectKey);
    if (await this.storage.head(incomingKey)) {
      try {
        await this.storage.move(incomingKey, objectKey);
      } catch (error) {
        if (!(await this.storage.head(objectKey))) throw error;
      }
    }
    return this.storage.head(objectKey);
  }

  async scanUploaded(fileId: string, context: { attempts: number; maxAttempts: number; requestId: string | null }): Promise<FileScanStatus | null> {
    const file = await this.db.file.findUnique({ where: { id: fileId } });
    if (!file || file.status !== FileStatus.PROCESSING || file.scanStatus !== FileScanStatus.PENDING) return null;
    const meta = { ip: null, userAgent: null, requestId: context.requestId };
    let verdict;
    try {
      const stream = await this.storage.openReadStream(file.objectKey);
      verdict = await this.scanner.scan(stream, { fileId, sizeBytes: Number(file.sizeBytes ?? 0), mimeType: file.mimeType });
    } catch (error) {
      if (context.attempts >= context.maxAttempts) {
        await this.db.file.updateMany({ where: { id: fileId, scanStatus: FileScanStatus.PENDING }, data: { scanStatus: FileScanStatus.FAILED, scanEngine: this.scanner.name } });
        await this.audit.record({ action: "file.scan_failed", category: AuditCategory.SECURITY, outcome: AuditOutcome.FAILURE, actorType: "SYSTEM", resourceType: "file", resourceId: fileId, institutionId: file.institutionId, metadata: { reason: error instanceof Error ? error.message : "unknown" }, meta });
      }
      if (error instanceof ScannerUnavailableError) throw error;
      throw new ScannerUnavailableError(error instanceof Error ? error.message : "scan failed");
    }
    const scannedAt = new Date();
    if (verdict.status === "clean") {
      const updated = await this.db.file.updateMany({
        where: { id: fileId, status: FileStatus.PROCESSING, scanStatus: FileScanStatus.PENDING },
        data: { status: FileStatus.READY, scanStatus: FileScanStatus.CLEAN, scanEngine: this.scanner.name, scannedAt, readyAt: scannedAt },
      });
      if (updated.count === 1) {
        await this.audit.record({ action: "file.scan_clean", category: AuditCategory.DATA, actorType: "SYSTEM", resourceType: "file", resourceId: fileId, institutionId: file.institutionId, metadata: { engine: this.scanner.name }, meta });
      }
      return FileScanStatus.CLEAN;
    }
    const quarantineKey = quarantineKeyFor(file.objectKey);
    let isolated = true;
    try {
      await this.storage.move(file.objectKey, quarantineKey);
    } catch (error) {
      isolated = false;
      this.logger.error({ err: error, fileId }, "failed to quarantine infected file, deleting it instead");
      await this.storage.delete(file.objectKey).catch(() => undefined);
    }
    await this.db.file.update({
      where: { id: fileId },
      data: {
        status: FileStatus.REJECTED,
        scanStatus: FileScanStatus.INFECTED,
        scanEngine: this.scanner.name,
        scanSignature: verdict.signature,
        scannedAt,
        rejectedReason: "MALWARE_DETECTED",
        quarantineKey: isolated ? quarantineKey : null,
      },
    });
    await this.audit.record({
      action: "file.malware_detected",
      category: AuditCategory.SECURITY,
      outcome: AuditOutcome.DENIED,
      actorType: "SYSTEM",
      resourceType: "file",
      resourceId: fileId,
      institutionId: file.institutionId,
      metadata: { signature: verdict.signature, engine: this.scanner.name, ownerId: file.ownerId, quarantined: isolated },
      meta,
      legalHold: true,
    });
    return FileScanStatus.INFECTED;
  }

  async requeueStalledScans(olderThanMs = 3600_000, limit = 100): Promise<number> {
    if (!this.scanner.enabled) return 0;
    const stalled = await this.db.file.findMany({
      where: { status: FileStatus.PROCESSING, scanStatus: { in: [FileScanStatus.PENDING, FileScanStatus.FAILED] }, uploadedAt: { lt: new Date(Date.now() - olderThanMs) }, deletedAt: null },
      select: { id: true },
      take: limit,
    });
    for (const file of stalled) {
      await this.db.$transaction(async (tx) => {
        await tx.file.update({ where: { id: file.id }, data: { scanStatus: FileScanStatus.PENDING, uploadedAt: new Date() } });
        await this.outbox.enqueue(tx, { type: FILE_SCAN_EVENT, aggregateType: "file", aggregateId: file.id, payload: { fileId: file.id } });
      });
    }
    return stalled.length;
  }

  private async canRead(userId: string | null, file: File): Promise<boolean> {
    if (userId && file.ownerId === userId) return true;
    if (file.visibility === FileVisibility.PUBLIC) return true;
    if (!userId) return false;
    switch (file.purpose) {
      case FilePurpose.LESSON_MEDIA:
      case FilePurpose.LESSON_RESOURCE:
      case FilePurpose.CAPTION: {
        const lessons = await this.db.lesson.findMany({
          where: {
            OR: [
              { mediaFileId: file.id },
              { resources: { some: { fileId: file.id } } },
              { mediaFile: { mediaTracks: { some: { trackFileId: file.id } } } },
            ],
          },
          select: { id: true },
          take: 5,
        });
        for (const lesson of lessons) {
          try {
            await this.access.requireLessonAccess(userId, lesson.id);
            return true;
          } catch {
            continue;
          }
        }
        return file.institutionId !== null && (await this.authz.can(userId, Permission.CourseRead, { institutionId: file.institutionId }));
      }
      case FilePurpose.MESSAGE_ATTACHMENT: {
        const count = await this.db.messageAttachment.count({
          where: { fileId: file.id, message: { deletedAt: null, conversation: { participants: { some: { userId, leftAt: null } } } } },
        });
        return count > 0;
      }
      case FilePurpose.SUBMISSION:
        return file.institutionId !== null && (await this.authz.can(userId, Permission.AssessmentGrade, { institutionId: file.institutionId }));
      default:
        return false;
    }
  }

  async describe(userId: string | null, fileId: string, inline: boolean) {
    const file = await this.db.file.findFirst({ where: { id: fileId, deletedAt: null } });
    if (!file || !(await this.canRead(userId, file))) throw notFound("File");
    const downloadUrl =
      isServable(file) && (file.expiresAt === null || file.expiresAt > new Date())
        ? await this.storage.createDownloadUrl(file.objectKey, {
            fileName: file.originalName,
            contentType: file.mimeType,
            expiresInSeconds: this.urlTtlSeconds,
            inline: inline && (file.mimeType.startsWith("image/") || file.mimeType.startsWith("video/") || file.mimeType.startsWith("audio/") || file.mimeType === "text/vtt"),
          })
        : null;
    return { ...this.present(file), downloadUrl, downloadUrlExpiresAt: downloadUrl ? new Date(Date.now() + this.urlTtlSeconds * 1000) : null };
  }

  async remove(userId: string, fileId: string, meta: RequestMeta) {
    const file = await this.db.file.findFirst({ where: { id: fileId, ownerId: userId, deletedAt: null } });
    if (!file) throw notFound("File");
    const references =
      (await this.db.lesson.count({ where: { mediaFileId: fileId } })) +
      (await this.db.lessonResource.count({ where: { fileId } })) +
      (await this.db.course.count({ where: { coverFileId: fileId } })) +
      (await this.db.messageAttachment.count({ where: { fileId } }));
    if (references > 0) throw conflict(ErrorCode.BUSINESS_RULE, "The file is still in use");
    await this.db.file.update({ where: { id: fileId }, data: { status: FileStatus.DELETED, deletedAt: new Date() } });
    await this.db.userProfile.updateMany({ where: { avatarFileId: fileId }, data: { avatarFileId: null } });
    await this.storage.delete(file.objectKey).catch(() => undefined);
    await this.audit.record({ action: "file.deleted", category: AuditCategory.DATA, actorId: userId, resourceType: "file", resourceId: fileId, meta });
  }

  present(file: File) {
    return {
      id: file.id,
      purpose: file.purpose,
      status: file.status,
      scanStatus: file.scanStatus,
      visibility: file.visibility,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes === null ? null : Number(file.sizeBytes),
      altText: file.altText,
      createdAt: file.createdAt,
      readyAt: file.readyAt,
      expiresAt: file.expiresAt,
    };
  }
}
