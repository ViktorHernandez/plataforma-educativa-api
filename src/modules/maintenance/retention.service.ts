import type { Logger } from "pino";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../core/database/prisma.js";
import type { StorageProvider } from "../../core/storage/storage-provider.js";
import { FileStatus } from "../../generated/prisma/enums.js";
import { incomingKeyFor } from "../files/file.service.js";

const DAY_MS = 24 * 3600 * 1000;

export type RetentionPolicy = Pick<AppConfig, "AUDIT_RETENTION_DAYS" | "AUDIT_SECURITY_RETENTION_DAYS" | "ACTIVITY_RETENTION_DAYS" | "NOTIFICATION_RETENTION_DAYS">;

export interface RetentionReport {
  auditLogs: number;
  activityEvents: number;
  notifications: number;
  expiredFiles: number;
  abandonedUploads: number;
}

export class RetentionService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageProvider,
    private readonly policy: RetentionPolicy,
    private readonly logger: Logger,
    private readonly batchSize = 5000,
    private readonly maxBatches = 200,
  ) {}

  cutoffs(now: Date) {
    return {
      audit: new Date(now.getTime() - this.policy.AUDIT_RETENTION_DAYS * DAY_MS),
      auditSecurity: new Date(now.getTime() - this.policy.AUDIT_SECURITY_RETENTION_DAYS * DAY_MS),
      activity: new Date(now.getTime() - this.policy.ACTIVITY_RETENTION_DAYS * DAY_MS),
      notifications: new Date(now.getTime() - this.policy.NOTIFICATION_RETENTION_DAYS * DAY_MS),
    };
  }

  private async repeat(step: () => Promise<number>): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < this.maxBatches; batch += 1) {
      const deleted = await step();
      total += deleted;
      if (deleted < this.batchSize) break;
    }
    return total;
  }

  async purgeAuditLogs(now: Date): Promise<number> {
    const { audit, auditSecurity } = this.cutoffs(now);
    return this.repeat(() =>
      this.db.$executeRaw`
        DELETE FROM "audit_logs" WHERE "id" IN (
          SELECT "id" FROM "audit_logs"
          WHERE "legalHold" = false
            AND (
              ("category" IN ('SECURITY', 'DATA') AND "occurredAt" < ${auditSecurity})
              OR ("category" NOT IN ('SECURITY', 'DATA') AND "occurredAt" < ${audit})
            )
          ORDER BY "occurredAt"
          LIMIT ${this.batchSize}
        )`,
    );
  }

  async purgeActivity(now: Date): Promise<number> {
    const { activity } = this.cutoffs(now);
    return this.repeat(() =>
      this.db.$executeRaw`
        DELETE FROM "activity_events" WHERE "id" IN (
          SELECT "id" FROM "activity_events" WHERE "occurredAt" < ${activity} ORDER BY "occurredAt" LIMIT ${this.batchSize}
        )`,
    );
  }

  async purgeNotifications(now: Date): Promise<number> {
    const { notifications } = this.cutoffs(now);
    return this.repeat(() =>
      this.db.$executeRaw`
        DELETE FROM "notifications" WHERE "id" IN (
          SELECT "id" FROM "notifications" WHERE "createdAt" < ${notifications} ORDER BY "createdAt" LIMIT ${this.batchSize}
        )`,
    );
  }

  async purgeExpiredFiles(now: Date): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < this.maxBatches; batch += 1) {
      const expired = await this.db.file.findMany({
        where: { expiresAt: { lt: now }, deletedAt: null },
        select: { id: true, objectKey: true },
        take: 200,
      });
      if (expired.length === 0) break;
      for (const file of expired) {
        await this.storage.delete(file.objectKey).catch((error: unknown) => this.logger.warn({ err: error, fileId: file.id }, "failed to delete expired object"));
      }
      const updated = await this.db.file.updateMany({ where: { id: { in: expired.map((file) => file.id) } }, data: { status: FileStatus.DELETED, deletedAt: now } });
      total += updated.count;
      if (expired.length < 200) break;
    }
    return total;
  }

  async purgeAbandonedUploads(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - DAY_MS);
    const abandoned = await this.db.file.findMany({ where: { status: FileStatus.PENDING_UPLOAD, createdAt: { lt: cutoff }, deletedAt: null }, select: { id: true, objectKey: true }, take: 1000 });
    for (const file of abandoned) {
      await this.storage.delete(incomingKeyFor(file.objectKey)).catch(() => undefined);
      await this.storage.delete(file.objectKey).catch(() => undefined);
    }
    const updated = await this.db.file.updateMany({ where: { id: { in: abandoned.map((file) => file.id) } }, data: { status: FileStatus.DELETED, deletedAt: now } });
    return updated.count;
  }

  async run(now = new Date()): Promise<RetentionReport> {
    const report: RetentionReport = {
      auditLogs: await this.purgeAuditLogs(now),
      activityEvents: await this.purgeActivity(now),
      notifications: await this.purgeNotifications(now),
      expiredFiles: await this.purgeExpiredFiles(now),
      abandonedUploads: await this.purgeAbandonedUploads(now),
    };
    this.logger.info({ report }, "retention finished");
    return report;
  }
}
