import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import { scopeKeyFor, type AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import { isUniqueViolation } from "../../core/database/prisma.js";
import { ErrorCode, badRequest, conflict, forbidden, notFound } from "../../core/http/errors.js";
import { buildCursorPage, decodeCursor, offsetMetaOf } from "../../core/http/pagination.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { EnrollmentStatus, RoleScope, SessionRevocationReason, UserStatus, type AuditCategory as AuditCategoryType, type AuditOutcome, type CourseStatus } from "../../generated/prisma/enums.js";
import type { SessionService } from "../auth/session.service.js";
import type { SecurityNotifier } from "../auth/security-notifier.js";

export interface AuditQuery {
  cursor?: string;
  limit: number;
  actorId?: string;
  action?: string;
  category?: AuditCategoryType;
  outcome?: AuditOutcome;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
}

export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly securityNotifier: SecurityNotifier,
  ) {}

  async users(actorId: string, query: { page: number; pageSize: number; search?: string; status?: UserStatus }) {
    await this.authz.require(actorId, Permission.UserRead);
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { OR: [{ email: { contains: query.search.toLowerCase() } }, { displayName: { contains: query.search, mode: "insensitive" } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.db.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: { id: true, email: true, displayName: true, status: true, mfaEnabled: true, emailVerifiedAt: true, lastLoginAt: true, createdAt: true },
      }),
      this.db.user.count({ where }),
    ]);
    return { data: items.map((user) => ({ ...user, emailVerified: user.emailVerifiedAt !== null })), meta: offsetMetaOf(query.page, query.pageSize, total) };
  }

  async user(actorId: string, userId: string) {
    await this.authz.require(actorId, Permission.UserRead);
    const user = await this.db.user.findUnique({
      where: { id: userId },
      include: {
        memberships: { include: { institution: { select: { id: true, name: true } } } },
        roleAssignments: { include: { role: { select: { key: true } } } },
        externalIdentities: { select: { provider: true, linkedAt: true } },
        _count: { select: { sessions: { where: { revokedAt: null } }, enrollments: true } },
      },
    });
    if (!user) throw notFound("User");
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      suspendedReason: user.suspendedReason,
      emailVerified: user.emailVerifiedAt !== null,
      mfaEnabled: user.mfaEnabled,
      hasPassword: user.passwordHash !== null,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      activeSessions: user._count.sessions,
      enrollments: user._count.enrollments,
      identities: user.externalIdentities,
      memberships: user.memberships.map((membership) => ({ institutionId: membership.institutionId, institutionName: membership.institution.name, memberType: membership.memberType, status: membership.status })),
      roles: user.roleAssignments.map((assignment) => ({ id: assignment.id, role: assignment.role.key, scope: assignment.scopeKey, expiresAt: assignment.expiresAt })),
    };
  }

  async setUserStatus(actorId: string, userId: string, status: "ACTIVE" | "SUSPENDED", reason: string, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.UserManage);
    if (actorId === userId) throw forbidden("You cannot change your own status");
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound("User");
    if (user.status === UserStatus.DEACTIVATED) throw conflict(ErrorCode.BUSINESS_RULE, "Deactivated accounts cannot be changed");
    await this.db.user.update({
      where: { id: userId },
      data: status === UserStatus.SUSPENDED ? { status, suspendedAt: new Date(), suspendedReason: reason } : { status, suspendedAt: null, suspendedReason: null },
    });
    if (status === UserStatus.SUSPENDED) await this.sessions.revokeAll(userId, SessionRevocationReason.ACCOUNT_SUSPENDED);
    await this.authz.invalidate(userId);
    await this.audit.record({ action: `admin.user.${status.toLowerCase()}`, category: AuditCategory.ADMINISTRATION, actorId, resourceType: "user", resourceId: userId, metadata: { reason }, meta });
  }

  async revokeSessions(actorId: string, userId: string, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.UserSessionsRevoke);
    const revoked = await this.sessions.revokeAll(userId, SessionRevocationReason.ADMIN_REVOKED);
    await this.audit.record({ action: "admin.user.sessions_revoked", category: AuditCategory.SECURITY, actorId, resourceType: "user", resourceId: userId, metadata: { revoked }, meta });
    return revoked;
  }

  async resetMfa(actorId: string, userId: string, reason: string, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.UserManage);
    await this.db.$transaction(async (tx) => {
      await tx.mfaFactor.deleteMany({ where: { userId } });
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.user.update({ where: { id: userId }, data: { mfaEnabled: false } });
      await this.audit.record({ action: "admin.user.mfa_reset", category: AuditCategory.SECURITY, actorId, resourceType: "user", resourceId: userId, metadata: { reason }, meta }, tx);
      await this.securityNotifier.notify(tx, userId, "mfaDisabled", {}, meta.requestId);
    });
    await this.sessions.revokeAll(userId, SessionRevocationReason.MFA_CHANGED);
  }

  async platformRoles(actorId: string) {
    await this.authz.require(actorId, Permission.RoleRead);
    const roles = await this.db.role.findMany({ where: { institutionId: null }, include: { permissions: true, _count: { select: { assignments: true } } }, orderBy: { key: "asc" } });
    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      scope: role.scope,
      isSystem: role.isSystem,
      permissions: role.permissions.map((item) => item.permission).sort(),
      assignments: role._count.assignments,
    }));
  }

  async assignPlatformRole(actorId: string, input: { userId: string; roleKey: string; expiresAt?: Date | null }, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.RoleAssign);
    const role = await this.db.role.findFirst({ where: { key: input.roleKey, institutionId: null, scope: RoleScope.PLATFORM }, include: { permissions: true } });
    if (!role) throw badRequest(ErrorCode.VALIDATION_FAILED, "Unknown platform role");
    for (const item of role.permissions) {
      if (!(await this.authz.hasPlatformPermission(actorId, item.permission as Permission))) throw forbidden("You cannot grant permissions you do not hold");
    }
    const user = await this.db.user.findFirst({ where: { id: input.userId, status: UserStatus.ACTIVE } });
    if (!user) throw notFound("User");
    try {
      const assignment = await this.db.roleAssignment.create({
        data: { userId: input.userId, roleId: role.id, scopeType: RoleScope.PLATFORM, scopeKey: scopeKeyFor({ type: RoleScope.PLATFORM }), grantedById: actorId, expiresAt: input.expiresAt ?? null },
      });
      await this.authz.invalidate(input.userId);
      await this.audit.record({ action: "admin.role.assigned", category: AuditCategory.ACCESS, actorId, resourceType: "role_assignment", resourceId: assignment.id, metadata: { userId: input.userId, role: role.key }, meta });
      return assignment;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Role already assigned");
      throw error;
    }
  }

  async revokePlatformRole(actorId: string, assignmentId: string, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.RoleAssign);
    const assignment = await this.db.roleAssignment.findFirst({ where: { id: assignmentId, scopeType: RoleScope.PLATFORM } });
    if (!assignment) throw notFound("Role assignment");
    if (assignment.userId === actorId) throw forbidden("You cannot revoke your own platform role");
    await this.db.roleAssignment.delete({ where: { id: assignmentId } });
    await this.authz.invalidate(assignment.userId);
    await this.audit.record({ action: "admin.role.revoked", category: AuditCategory.ACCESS, actorId, resourceType: "role_assignment", resourceId: assignmentId, metadata: { userId: assignment.userId }, meta });
  }

  async auditLogs(actorId: string, institutionId: string | null, query: AuditQuery) {
    if (institutionId) await this.authz.require(actorId, Permission.AuditRead, { institutionId }, { hideAs: "Institution" });
    else await this.authz.require(actorId, Permission.AuditRead);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.db.auditLog.findMany({
      where: {
        ...(institutionId ? { institutionId } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.action ? { action: { startsWith: query.action } } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(query.resourceType ? { resourceType: query.resourceType } : {}),
        ...(query.resourceId ? { resourceId: query.resourceId } : {}),
        ...(query.from || query.to ? { occurredAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } } : {}),
        ...(cursor ? { id: { lt: cursor.id } } : {}),
      },
      orderBy: { id: "desc" },
      take: query.limit + 1,
    });
    return buildCursorPage(
      rows.map((row) => ({ ...row, metadata: (row.metadata ?? null) as Record<string, unknown> | null })),
      query.limit,
    );
  }

  async overview(actorId: string) {
    await this.authz.require(actorId, Permission.ReportRead);
    const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const [usersByStatus, institutions, coursesByStatus, enrollmentsByStatus, signups7d, activeLearners7d, failedLogins24h, outboxFailed] = await Promise.all([
      this.db.user.groupBy({ by: ["status"], _count: { _all: true } }),
      this.db.institution.count(),
      this.db.course.groupBy({ by: ["status"], where: { deletedAt: null }, _count: { _all: true } }),
      this.db.enrollment.groupBy({ by: ["status"], _count: { _all: true } }),
      this.db.user.count({ where: { createdAt: { gte: since7d } } }),
      this.db.enrollment.count({ where: { lastActivityAt: { gte: since7d }, status: EnrollmentStatus.ACTIVE } }),
      this.db.auditLog.count({ where: { action: "auth.login.failed", occurredAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } }),
      this.db.outboxEvent.count({ where: { failedAt: { not: null } } }),
    ]);
    return {
      users: Object.fromEntries(usersByStatus.map((item) => [item.status, item._count._all])),
      institutions,
      courses: Object.fromEntries(coursesByStatus.map((item) => [item.status, item._count._all])) as Partial<Record<CourseStatus, number>>,
      enrollments: Object.fromEntries(enrollmentsByStatus.map((item) => [item.status, item._count._all])),
      signupsLast7Days: signups7d,
      activeLearnersLast7Days: activeLearners7d,
      failedLoginsLast24Hours: failedLogins24h,
      failedBackgroundEvents: outboxFailed,
    };
  }

  async failedEvents(actorId: string, limit: number) {
    await this.authz.require(actorId, Permission.PlatformSettingsManage);
    return this.db.outboxEvent.findMany({
      where: { failedAt: { not: null } },
      orderBy: { failedAt: "desc" },
      take: limit,
      select: { id: true, type: true, aggregateType: true, aggregateId: true, attempts: true, lastError: true, createdAt: true, failedAt: true },
    });
  }

  async retryEvent(actorId: string, eventId: string, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.PlatformSettingsManage);
    const result = await this.db.outboxEvent.updateMany({
      where: { id: eventId, failedAt: { not: null } },
      data: { failedAt: null, dispatchedAt: null, attempts: 0, availableAt: new Date() },
    });
    if (result.count === 0) throw notFound("Event");
    await this.audit.record({ action: "admin.outbox.retried", category: AuditCategory.ADMINISTRATION, actorId, resourceType: "outbox_event", resourceId: eventId, meta });
  }
}
