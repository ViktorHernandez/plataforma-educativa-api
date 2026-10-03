import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { Permission } from "../../core/authz/permissions.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { cursorPage, cursorQuery, dataEnvelope, idParams, isoDateTime, offsetPage, offsetQuery, okResponse, standardErrors, trimmedString } from "../../core/http/schemas.js";
import { AuditCategory, AuditOutcome, UserStatus } from "../../generated/prisma/enums.js";
import { exportTypes } from "../reports/report.service.js";

const security = [{ bearerAuth: [] }];

const auditItem = z.object({
  id: z.uuid(),
  occurredAt: isoDateTime,
  actorId: z.uuid().nullable(),
  actorType: z.string(),
  action: z.string(),
  category: z.enum(AuditCategory),
  outcome: z.enum(AuditOutcome),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  institutionId: z.uuid().nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

const auditQuery = cursorQuery
  .extend({
    actorId: z.uuid().optional(),
    action: z.string().max(100).optional(),
    category: z.enum(AuditCategory).optional(),
    outcome: z.enum(AuditOutcome).optional(),
    resourceType: z.string().max(60).optional(),
    resourceId: z.string().max(80).optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
  })
  .strict();

export function registerAdminRoutes(app: AppInstance, container: Container): void {
  const { admin, settings, reports, authenticator, authz } = container;
  const tags = ["Administration"];

  app.get(
    "/admin/overview",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Platform KPIs",
        response: {
          200: dataEnvelope(
            z.object({
              users: z.record(z.string(), z.number()),
              institutions: z.number().int(),
              courses: z.record(z.string(), z.number()),
              enrollments: z.record(z.string(), z.number()),
              signupsLast7Days: z.number().int(),
              activeLearnersLast7Days: z.number().int(),
              failedLoginsLast24Hours: z.number().int(),
              failedBackgroundEvents: z.number().int(),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await admin.overview(requireAuth(request).userId) }),
  );

  app.get(
    "/admin/users",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Search users",
        querystring: offsetQuery.extend({ search: z.string().trim().max(100).optional(), status: z.enum(UserStatus).optional() }).strict(),
        response: {
          200: offsetPage(
            z.object({
              id: z.uuid(),
              email: z.string(),
              displayName: z.string(),
              status: z.enum(UserStatus),
              mfaEnabled: z.boolean(),
              emailVerified: z.boolean(),
              lastLoginAt: isoDateTime.nullable(),
              createdAt: isoDateTime,
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => admin.users(requireAuth(request).userId, request.query),
  );

  app.get(
    "/admin/users/:id",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "User detail",
        params: idParams,
        response: {
          200: dataEnvelope(
            z.object({
              id: z.uuid(),
              email: z.string(),
              displayName: z.string(),
              status: z.enum(UserStatus),
              suspendedReason: z.string().nullable(),
              emailVerified: z.boolean(),
              mfaEnabled: z.boolean(),
              hasPassword: z.boolean(),
              lastLoginAt: isoDateTime.nullable(),
              createdAt: isoDateTime,
              activeSessions: z.number().int(),
              enrollments: z.number().int(),
              identities: z.array(z.object({ provider: z.string(), linkedAt: isoDateTime })),
              memberships: z.array(z.object({ institutionId: z.uuid(), institutionName: z.string(), memberType: z.string(), status: z.string() })),
              roles: z.array(z.object({ id: z.uuid(), role: z.string(), scope: z.string(), expiresAt: isoDateTime.nullable() })),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await admin.user(requireAuth(request).userId, request.params.id) }),
  );

  app.post(
    "/admin/users/:id/status",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Suspend or reactivate a user",
        params: idParams,
        body: z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]), reason: trimmedString(3, 500) }).strict(),
        response: { 200: okResponse, ...standardErrors },
      },
    },
    async (request) => {
      await admin.setUserStatus(requireAuth(request).userId, request.params.id, request.body.status, request.body.reason, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/admin/users/:id/sessions/revoke",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Close every session of a user", params: idParams, response: { 200: dataEnvelope(z.object({ revoked: z.number().int() })), ...standardErrors } } },
    async (request) => ({ data: { revoked: await admin.revokeSessions(requireAuth(request).userId, request.params.id, requestMeta(request)) } }),
  );

  app.post(
    "/admin/users/:id/mfa/reset",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Reset two-factor authentication after identity verification", params: idParams, body: z.object({ reason: trimmedString(10, 500) }).strict(), response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      await admin.resetMfa(requireAuth(request).userId, request.params.id, request.body.reason, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.get(
    "/admin/roles",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "System roles",
        response: {
          200: dataEnvelope(z.array(z.object({ id: z.uuid(), key: z.string(), name: z.string(), scope: z.string(), isSystem: z.boolean(), permissions: z.array(z.string()), assignments: z.number().int() }))),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await admin.platformRoles(requireAuth(request).userId) }),
  );

  app.post(
    "/admin/role-assignments",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Grant a platform role",
        body: z.object({ userId: z.uuid(), roleKey: z.enum(["platform_admin", "platform_support"]), expiresAt: isoDateTime.nullable().optional() }).strict(),
        response: { 201: dataEnvelope(z.object({ id: z.uuid() })), ...standardErrors },
      },
    },
    async (request, reply) => {
      const assignment = await admin.assignPlatformRole(requireAuth(request).userId, request.body, requestMeta(request));
      reply.code(201);
      return { data: { id: assignment.id } };
    },
  );

  app.delete(
    "/admin/role-assignments/:id",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Revoke a platform role", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await admin.revokePlatformRole(requireAuth(request).userId, request.params.id, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.get(
    "/admin/audit-logs",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Platform audit trail", querystring: auditQuery, response: { 200: cursorPage(auditItem), ...standardErrors } } },
    async (request) => admin.auditLogs(requireAuth(request).userId, null, request.query),
  );

  app.get(
    "/institutions/:id/audit-logs",
    {
      preHandler: authenticator.required,
      schema: { tags: ["Institutions"], security, summary: "Institution audit trail", params: idParams, querystring: auditQuery, response: { 200: cursorPage(auditItem), ...standardErrors } },
    },
    async (request) => admin.auditLogs(requireAuth(request).userId, request.params.id, request.query),
  );

  app.get(
    "/admin/settings",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Global settings", response: { 200: dataEnvelope(z.array(z.object({ key: z.string(), value: z.unknown(), updatedAt: isoDateTime.nullable() }))), ...standardErrors } },
    },
    async (request) => {
      await authz.require(requireAuth(request).userId, Permission.PlatformSettingsManage);
      return { data: await settings.list() };
    },
  );

  app.put(
    "/admin/settings/:key",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Update a global setting",
        params: z.object({ key: z.string().regex(/^[a-zA-Z0-9._]{3,100}$/) }).strict(),
        body: z.object({ value: z.unknown() }).strict(),
        response: { 200: dataEnvelope(z.object({ key: z.string(), value: z.unknown() })), ...standardErrors },
      },
    },
    async (request) => {
      const current = requireAuth(request);
      await authz.require(current.userId, Permission.PlatformSettingsManage);
      const value = await settings.set(request.params.key, request.body.value, current.userId);
      await container.audit.record({ action: "admin.setting.updated", category: AuditCategory.ADMINISTRATION, actorId: current.userId, resourceType: "setting", resourceId: request.params.key, meta: requestMeta(request) });
      return { data: { key: request.params.key, value } };
    },
  );

  app.get(
    "/admin/background-events/failed",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Background events that exhausted retries",
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict(),
        response: {
          200: dataEnvelope(
            z.array(
              z.object({
                id: z.uuid(),
                type: z.string(),
                aggregateType: z.string().nullable(),
                aggregateId: z.string().nullable(),
                attempts: z.number().int(),
                lastError: z.string().nullable(),
                createdAt: isoDateTime,
                failedAt: isoDateTime.nullable(),
              }),
            ),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await admin.failedEvents(requireAuth(request).userId, request.query.limit) }),
  );

  app.post(
    "/admin/background-events/:id/retry",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Retry a failed background event", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await admin.retryEvent(requireAuth(request).userId, request.params.id, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.get(
    "/institutions/:id/reports/overview",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Reports"],
        security,
        summary: "Institution KPIs",
        params: idParams,
        response: {
          200: dataEnvelope(
            z.object({
              institutionId: z.uuid(),
              membersByType: z.record(z.string(), z.number()),
              coursesByStatus: z.record(z.string(), z.number()),
              enrollmentsByStatus: z.record(z.string(), z.number()),
              completionsLast30Days: z.number().int(),
              activeLearnersLast7Days: z.number().int(),
              averageActiveProgressPercent: z.number().nullable(),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await reports.institutionOverview(requireAuth(request).userId, request.params.id) }),
  );

  app.get(
    "/courses/:id/reports/progress",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Reports"],
        security,
        summary: "Course progress, completion and learners at risk",
        params: idParams,
        response: {
          200: dataEnvelope(
            z.object({
              courseId: z.uuid(),
              enrollmentsByStatus: z.record(z.string(), z.number()),
              completionRate: z.number().nullable(),
              averageProgressPercent: z.number().nullable(),
              averageFinalScorePercent: z.number().nullable(),
              totalTimeSpentSeconds: z.number().int(),
              modules: z.array(z.object({ moduleId: z.uuid(), title: z.string(), learnersWithProgress: z.number().int(), learnersCompleted: z.number().int(), averageProgressPercent: z.number().nullable() })),
              atRiskLearners: z.array(
                z.object({ enrollmentId: z.uuid(), progressPercent: z.number().int(), lastActivityAt: isoDateTime.nullable(), user: z.object({ id: z.uuid(), displayName: z.string(), email: z.string() }) }),
              ),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await reports.courseProgress(requireAuth(request).userId, request.params.id) }),
  );

  const exportSchema = z.object({
    id: z.uuid(),
    type: z.string(),
    status: z.string(),
    error: z.string().nullable(),
    createdAt: isoDateTime,
    completedAt: isoDateTime.nullable(),
    expiresAt: isoDateTime.nullable(),
    rowCount: z.number().int().nullable(),
    expired: z.boolean(),
    downloadUrl: z.string().nullable(),
  });

  app.post(
    "/reports/exports",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Reports"],
        security,
        summary: "Request an asynchronous CSV export",
        body: z.object({ type: z.enum(exportTypes), courseId: z.uuid().optional(), assessmentId: z.uuid().optional(), institutionId: z.uuid().optional() }).strict(),
        response: { 202: dataEnvelope(exportSchema), ...standardErrors },
      },
    },
    async (request, reply) => {
      reply.code(202);
      return { data: await reports.requestExport(requireAuth(request).userId, request.body, requestMeta(request)) };
    },
  );

  app.get(
    "/reports/exports/:id",
    { preHandler: authenticator.required, schema: { tags: ["Reports"], security, summary: "Export status and download link", params: idParams, response: { 200: dataEnvelope(exportSchema), ...standardErrors } } },
    async (request) => ({ data: await reports.getExport(requireAuth(request).userId, request.params.id) }),
  );
}
