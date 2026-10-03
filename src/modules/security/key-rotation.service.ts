import type { Logger } from "pino";
import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import type { AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import { columnKey, encryptedColumns, type EncryptedColumn } from "../../core/crypto/encrypted-columns.js";
import type { FieldEncryptor } from "../../core/crypto/field-encryption.js";
import type { Database } from "../../core/database/prisma.js";
import { isUniqueViolation, Prisma } from "../../core/database/prisma.js";
import type { OutboxService } from "../../core/events/outbox.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { KeyRotationRun } from "../../generated/prisma/client.js";
import { ActorType, KeyRotationStatus } from "../../generated/prisma/enums.js";

export const KEY_ROTATION_EVENT = "security.encryption.reencrypt";
const STALLED_RUN_MS = 30 * 60 * 1000;

interface ColumnProgress {
  cursor: string | null;
  rotated: number;
  failed: number;
  done: boolean;
}

type RunProgress = Record<string, ColumnProgress>;

export interface RotationStepResult {
  runId: string;
  processed: number;
  failed: number;
  completed: boolean;
}

function identifier(name: string): Prisma.Sql {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid identifier ${name}`);
  return Prisma.raw(`"${name}"`);
}

export class KeyRotationService {
  constructor(
    private readonly db: Database,
    private readonly encryptor: FieldEncryptor,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
    private readonly logger: Logger,
    private readonly batchSize: number,
    private readonly columns: EncryptedColumn[] = encryptedColumns,
  ) {}

  async keyUsage(): Promise<Array<{ column: string; keyId: string; rows: number }>> {
    const usage: Array<{ column: string; keyId: string; rows: number }> = [];
    for (const column of this.columns) {
      const rows = await this.db.$queryRaw<Array<{ keyId: string | null; rows: bigint }>>(
        Prisma.sql`SELECT split_part(${identifier(column.column)}, '.', 2) AS "keyId", count(*) AS "rows" FROM ${identifier(column.table)} WHERE ${identifier(column.column)} IS NOT NULL GROUP BY 1`,
      );
      for (const row of rows) usage.push({ column: columnKey(column), keyId: row.keyId ?? "", rows: Number(row.rows) });
    }
    return usage;
  }

  async status(actorId: string) {
    await this.authz.require(actorId, Permission.SecurityKeysManage);
    const usage = await this.keyUsage();
    const active = this.encryptor.activeKey;
    const lastRun = await this.db.keyRotationRun.findFirst({ orderBy: { startedAt: "desc" } });
    const keys = this.encryptor.keyIds.map((keyId) => {
      const rows = usage.filter((item) => item.keyId === keyId).reduce((sum, item) => sum + item.rows, 0);
      return { keyId, active: keyId === active, rows, retirable: keyId !== active && rows === 0 };
    });
    const unknownKeys = [...new Set(usage.map((item) => item.keyId))].filter((keyId) => !this.encryptor.keyIds.includes(keyId));
    return {
      activeKeyId: active,
      keys,
      unknownKeyIds: unknownKeys,
      pendingRows: usage.filter((item) => item.keyId !== active).reduce((sum, item) => sum + item.rows, 0),
      columns: usage,
      lastRun: lastRun ? this.presentRun(lastRun) : null,
    };
  }

  presentRun(run: KeyRotationRun) {
    return {
      id: run.id,
      targetKeyId: run.targetKeyId,
      status: run.status,
      processed: run.processed,
      failed: run.failed,
      lastError: run.lastError,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    };
  }

  private async pendingRows(): Promise<number> {
    const active = this.encryptor.activeKey;
    let total = 0;
    for (const column of this.columns) {
      const rows = await this.db.$queryRaw<Array<{ rows: bigint }>>(
        Prisma.sql`SELECT count(*) AS "rows" FROM ${identifier(column.table)} WHERE ${identifier(column.column)} IS NOT NULL AND split_part(${identifier(column.column)}, '.', 2) <> ${active}`,
      );
      total += Number(rows[0]?.rows ?? 0);
    }
    return total;
  }

  async start(actorId: string | null, meta: RequestMeta | null): Promise<KeyRotationRun | null> {
    const running = await this.db.keyRotationRun.findFirst({ where: { status: KeyRotationStatus.RUNNING } });
    if (running) return this.resumeIfStalled(running);
    if ((await this.pendingRows()) === 0) return null;
    try {
      return await this.db.$transaction(async (tx) => {
        const run = await tx.keyRotationRun.create({ data: { targetKeyId: this.encryptor.activeKey, requestedById: actorId } });
        await this.outbox.enqueue(tx, { type: KEY_ROTATION_EVENT, aggregateType: "key_rotation_run", aggregateId: run.id, payload: { runId: run.id }, requestId: meta?.requestId ?? null });
        await this.audit.record(
          {
            action: "security.encryption.rotation_started",
            category: AuditCategory.SECURITY,
            actorId,
            actorType: actorId ? ActorType.USER : ActorType.SYSTEM,
            resourceType: "key_rotation_run",
            resourceId: run.id,
            metadata: { targetKeyId: run.targetKeyId },
            meta: meta ?? undefined,
          },
          tx,
        );
        return run;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.db.keyRotationRun.findFirst({ where: { status: KeyRotationStatus.RUNNING } });
    }
  }

  private async resumeIfStalled(run: KeyRotationRun): Promise<KeyRotationRun> {
    if (run.updatedAt.getTime() > Date.now() - STALLED_RUN_MS) return run;
    const pending = await this.db.outboxEvent.count({ where: { type: KEY_ROTATION_EVENT, aggregateId: run.id, processedAt: null, failedAt: null } });
    if (pending > 0) return run;
    return this.db.$transaction(async (tx) => {
      const touched = await tx.keyRotationRun.update({ where: { id: run.id }, data: { lastError: run.lastError } });
      await this.outbox.enqueue(tx, { type: KEY_ROTATION_EVENT, aggregateType: "key_rotation_run", aggregateId: run.id, payload: { runId: run.id } });
      this.logger.warn({ runId: run.id }, "resumed a stalled re-encryption run");
      return touched;
    });
  }

  async requestRotation(actorId: string, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.SecurityKeysManage);
    const run = await this.start(actorId, meta);
    return run ? this.presentRun(run) : null;
  }

  private async rotateColumnBatch(column: EncryptedColumn, progress: ColumnProgress, targetKeyId: string): Promise<{ rotated: number; failed: number; lastError: string | null }> {
    const context = column.contextColumns.map((name) => Prisma.sql`${identifier(name)}::text AS ${identifier(name)}`);
    const rows = await this.db.$queryRaw<Array<Record<string, string | null> & { id: string; value: string }>>(
      Prisma.sql`SELECT "id"::text AS "id", ${identifier(column.column)} AS "value", ${Prisma.join(context)}
        FROM ${identifier(column.table)}
        WHERE ${identifier(column.column)} IS NOT NULL
          AND split_part(${identifier(column.column)}, '.', 2) <> ${targetKeyId}
          ${progress.cursor ? Prisma.sql`AND "id" > ${progress.cursor}::uuid` : Prisma.empty}
        ORDER BY "id"
        LIMIT ${this.batchSize}`,
    );
    let rotated = 0;
    let failed = 0;
    let lastError: string | null = null;
    for (const row of rows) {
      try {
        const aad = column.aad(row);
        const next = this.encryptor.rotate(row.value, aad);
        const updated = await this.db.$executeRaw(
          Prisma.sql`UPDATE ${identifier(column.table)} SET ${identifier(column.column)} = ${next} WHERE "id" = ${row.id}::uuid AND ${identifier(column.column)} = ${row.value}`,
        );
        if (updated === 1) rotated += 1;
      } catch (error) {
        failed += 1;
        lastError = `${columnKey(column)} ${row.id}: ${error instanceof Error ? error.message : "failed"}`.slice(0, 1000);
        this.logger.error({ err: error, column: columnKey(column), rowId: row.id }, "re-encryption failed for row");
      }
    }
    progress.cursor = rows.length > 0 ? rows[rows.length - 1]!.id : progress.cursor;
    progress.rotated += rotated;
    progress.failed += failed;
    progress.done = rows.length < this.batchSize;
    return { rotated, failed, lastError };
  }

  async runStep(runId: string, maxBatches = 20, continueInBackground = true): Promise<RotationStepResult | null> {
    const run = await this.db.keyRotationRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== KeyRotationStatus.RUNNING) return null;
    if (run.targetKeyId !== this.encryptor.activeKey) {
      await this.db.keyRotationRun.update({ where: { id: runId }, data: { status: KeyRotationStatus.FAILED, lastError: "The active key changed while the run was in progress", completedAt: new Date() } });
      return { runId, processed: 0, failed: 0, completed: true };
    }
    const progress = { ...(run.progress as unknown as RunProgress) };
    let processed = 0;
    let failed = 0;
    let lastError: string | null = run.lastError;
    let batches = 0;
    for (const column of this.columns) {
      const key = columnKey(column);
      const state: ColumnProgress = progress[key] ?? { cursor: null, rotated: 0, failed: 0, done: false };
      progress[key] = state;
      while (!state.done && batches < maxBatches) {
        const result = await this.rotateColumnBatch(column, state, run.targetKeyId);
        batches += 1;
        processed += result.rotated;
        failed += result.failed;
        if (result.lastError) lastError = result.lastError;
        await this.db.keyRotationRun.update({
          where: { id: runId },
          data: { progress: progress as unknown as Prisma.InputJsonValue, processed: { increment: result.rotated }, failed: { increment: result.failed }, lastError },
        });
      }
      if (batches >= maxBatches) break;
    }
    const completed = this.columns.every((column) => progress[columnKey(column)]?.done === true);
    if (completed) {
      const remaining = await this.pendingRows();
      const current = await this.db.keyRotationRun.findUniqueOrThrow({ where: { id: runId } });
      const status = remaining === 0 ? KeyRotationStatus.COMPLETED : KeyRotationStatus.FAILED;
      await this.db.keyRotationRun.update({ where: { id: runId }, data: { status, completedAt: new Date(), lastError: remaining > 0 ? `${remaining} rows still use an old key${lastError ? `; ${lastError}` : ""}`.slice(0, 1000) : lastError } });
      await this.audit.record({
        action: "security.encryption.rotation_finished",
        category: AuditCategory.SECURITY,
        actorType: ActorType.SYSTEM,
        resourceType: "key_rotation_run",
        resourceId: runId,
        metadata: { status, processed: current.processed, failed: current.failed, remaining },
      });
      return { runId, processed, failed, completed: true };
    }
    if (continueInBackground) {
      await this.outbox.enqueue(this.db, { type: KEY_ROTATION_EVENT, aggregateType: "key_rotation_run", aggregateId: runId, payload: { runId } });
    }
    return { runId, processed, failed, completed: false };
  }

  async runToCompletion(actorId: string | null = null): Promise<KeyRotationRun | null> {
    const run = await this.start(actorId, null);
    if (!run) return null;
    for (;;) {
      const step = await this.runStep(run.id, 1000, false);
      if (!step || step.completed) break;
    }
    return this.db.keyRotationRun.findUnique({ where: { id: run.id } });
  }
}
