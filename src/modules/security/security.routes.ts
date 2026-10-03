import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { Permission } from "../../core/authz/permissions.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { dataEnvelope, isoDateTime, standardErrors } from "../../core/http/schemas.js";
import { KeyRotationStatus } from "../../generated/prisma/enums.js";

const tags = ["Administration"];
const security = [{ bearerAuth: [] }];

const runSchema = z.object({
  id: z.uuid(),
  targetKeyId: z.string(),
  status: z.enum(KeyRotationStatus),
  processed: z.number().int(),
  failed: z.number().int(),
  lastError: z.string().nullable(),
  startedAt: isoDateTime,
  completedAt: isoDateTime.nullable(),
});

export function registerSecurityRoutes(app: AppInstance, container: Container): void {
  const { keyRotation, retention, authenticator, authz } = container;

  app.get(
    "/admin/security/encryption",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Encryption keyring usage and re-encryption progress",
        response: {
          200: dataEnvelope(
            z.object({
              activeKeyId: z.string(),
              keys: z.array(z.object({ keyId: z.string(), active: z.boolean(), rows: z.number().int(), retirable: z.boolean() })),
              unknownKeyIds: z.array(z.string()),
              pendingRows: z.number().int(),
              columns: z.array(z.object({ column: z.string(), keyId: z.string(), rows: z.number().int() })),
              lastRun: runSchema.nullable(),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await keyRotation.status(requireAuth(request).userId) }),
  );

  app.post(
    "/admin/security/encryption/rotations",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Re-encrypt every stored secret with the active key",
        response: { 202: dataEnvelope(z.object({ run: runSchema.nullable() })), ...standardErrors },
      },
    },
    async (request, reply) => {
      reply.code(202);
      return { data: { run: await keyRotation.requestRotation(requireAuth(request).userId, requestMeta(request)) } };
    },
  );

  app.get(
    "/admin/maintenance/retention",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Configured retention policy and current cutoffs",
        response: {
          200: dataEnvelope(
            z.object({
              auditRetentionDays: z.number().int(),
              auditSecurityRetentionDays: z.number().int(),
              activityRetentionDays: z.number().int(),
              notificationRetentionDays: z.number().int(),
              cutoffs: z.object({ audit: isoDateTime, auditSecurity: isoDateTime, activity: isoDateTime, notifications: isoDateTime }),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      await authz.require(requireAuth(request).userId, Permission.AuditRead);
      const config = container.config;
      return {
        data: {
          auditRetentionDays: config.AUDIT_RETENTION_DAYS,
          auditSecurityRetentionDays: config.AUDIT_SECURITY_RETENTION_DAYS,
          activityRetentionDays: config.ACTIVITY_RETENTION_DAYS,
          notificationRetentionDays: config.NOTIFICATION_RETENTION_DAYS,
          cutoffs: retention.cutoffs(new Date()),
        },
      };
    },
  );
}
