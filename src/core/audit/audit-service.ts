import type { Logger } from "pino";
import type { DbClient } from "../database/prisma.js";
import { ActorType, AuditCategory, AuditOutcome } from "../../generated/prisma/enums.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { RequestMeta } from "../http/request-context.js";

export interface AuditEntry {
  action: string;
  category: AuditCategory;
  outcome?: AuditOutcome;
  actorId?: string | null;
  actorType?: ActorType;
  resourceType?: string;
  resourceId?: string;
  institutionId?: string | null;
  metadata?: Record<string, unknown>;
  meta?: RequestMeta;
  legalHold?: boolean;
}

export const legalHoldActionPrefixes = ["privacy.", "security.encryption."];

export function requiresLegalHold(entry: Pick<AuditEntry, "action" | "legalHold">): boolean {
  return entry.legalHold ?? legalHoldActionPrefixes.some((prefix) => entry.action.startsWith(prefix));
}

const sensitiveKey = /pass(word)?|token|secret|code|otp|authorization|cookie|key/i;

export function sanitizeAuditMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeAuditMetadata(item, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      output[key] = sensitiveKey.test(key) ? "[REDACTED]" : sanitizeAuditMetadata(item, depth + 1);
    }
    return output;
  }
  if (typeof value === "string") return value.slice(0, 500);
  return value;
}

export class AuditService {
  constructor(
    private readonly db: DbClient,
    private readonly logger: Logger,
  ) {}

  async record(entry: AuditEntry, client: DbClient = this.db): Promise<void> {
    const data: Prisma.AuditLogUncheckedCreateInput = {
      action: entry.action,
      category: entry.category,
      outcome: entry.outcome ?? AuditOutcome.SUCCESS,
      actorId: entry.actorId ?? null,
      actorType: entry.actorType ?? (entry.actorId ? ActorType.USER : ActorType.ANONYMOUS),
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      institutionId: entry.institutionId ?? null,
      ipAddress: entry.meta?.ip ?? null,
      userAgent: entry.meta?.userAgent ?? null,
      requestId: entry.meta?.requestId ?? null,
      metadata: entry.metadata ? (sanitizeAuditMetadata(entry.metadata) as Prisma.InputJsonValue) : undefined,
      legalHold: requiresLegalHold(entry),
    };
    try {
      await client.auditLog.create({ data });
    } catch (error) {
      this.logger.error({ err: error, action: entry.action }, "audit write failed");
      if (client !== this.db) throw error;
    }
  }
}

export { AuditCategory, AuditOutcome, ActorType };
