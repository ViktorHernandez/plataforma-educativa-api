import type { AppConfig } from "../../config/env.js";
import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import { scopeKeyFor, type AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission, SystemRole, systemRoles } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import { isUniqueViolation } from "../../core/database/prisma.js";
import { ErrorCode, badRequest, conflict, forbidden, notFound } from "../../core/http/errors.js";
import { offsetMetaOf } from "../../core/http/pagination.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { EmailQueue } from "../../core/mail/email-queue.js";
import { EmailTemplate } from "../../core/mail/templates.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { InstitutionStatus, MemberType } from "../../generated/prisma/enums.js";
import { InstitutionType, MembershipStatus, RoleScope, UserStatus, VerificationPurpose } from "../../generated/prisma/enums.js";
import { ACCOUNT_SETUP_TTL_SECONDS } from "../auth/auth.service.js";
import type { VerificationTokenService } from "../auth/verification-token.service.js";

const defaultRoleByMemberType: Record<MemberType, string | null> = {
  STUDENT: SystemRole.Student,
  TEACHER: SystemRole.Teacher,
  ADMIN: SystemRole.InstitutionAdmin,
  STAFF: null,
};

const institutionScopedPermissions = new Set<string>(systemRoles.find((role) => role.key === SystemRole.InstitutionAdmin)!.permissions);
const courseScopedPermissions = new Set<string>(systemRoles.find((role) => role.key === SystemRole.CourseInstructor)!.permissions);

export interface InstitutionInput {
  slug: string;
  name: string;
  type?: InstitutionType;
  defaultLocale?: string;
  defaultTimezone?: string;
  defaultCurrency?: string;
  customDomain?: string | null;
  settings?: Record<string, unknown>;
  branding?: Record<string, unknown>;
}

export class InstitutionService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly tokens: VerificationTokenService,
    private readonly emails: EmailQueue,
  ) {}

  async isActiveMember(userId: string, institutionId: string): Promise<boolean> {
    const membership = await this.db.institutionMembership.findUnique({
      where: { institutionId_userId: { institutionId, userId } },
      select: { status: true },
    });
    return membership?.status === MembershipStatus.ACTIVE;
  }

  async requireVisible(userId: string, institutionId: string) {
    const institution = await this.db.institution.findUnique({ where: { id: institutionId } });
    if (!institution) throw notFound("Institution");
    const allowed = (await this.isActiveMember(userId, institutionId)) || (await this.authz.can(userId, Permission.InstitutionRead, { institutionId }));
    if (!allowed) throw notFound("Institution");
    return institution;
  }

  async create(actorId: string, input: InstitutionInput, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.InstitutionCreate);
    try {
      const institution = await this.db.institution.create({
        data: {
          slug: input.slug,
          name: input.name,
          type: input.type ?? InstitutionType.OTHER,
          defaultLocale: input.defaultLocale ?? "es",
          defaultTimezone: input.defaultTimezone ?? "UTC",
          defaultCurrency: input.defaultCurrency ?? "USD",
          customDomain: input.customDomain ?? null,
          settings: (input.settings ?? {}) as Prisma.InputJsonValue,
          branding: (input.branding ?? {}) as Prisma.InputJsonValue,
        },
      });
      await this.audit.record({ action: "institution.created", category: AuditCategory.ADMINISTRATION, actorId, resourceType: "institution", resourceId: institution.id, institutionId: institution.id, meta });
      return institution;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Slug or domain already in use");
      throw error;
    }
  }

  async list(actorId: string, query: { page: number; pageSize: number; search?: string; status?: InstitutionStatus }) {
    const scope = await this.authz.institutionsWithPermission(actorId, Permission.InstitutionRead);
    const memberOf = await this.db.institutionMembership.findMany({ where: { userId: actorId, status: MembershipStatus.ACTIVE }, select: { institutionId: true } });
    const visibleIds = scope === "all" ? null : [...new Set([...scope, ...memberOf.map((item) => item.institutionId)])];
    const where: Prisma.InstitutionWhereInput = {
      ...(visibleIds ? { id: { in: visibleIds } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { OR: [{ name: { contains: query.search, mode: "insensitive" } }, { slug: { contains: query.search.toLowerCase() } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.db.institution.findMany({ where, orderBy: { name: "asc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.institution.count({ where }),
    ]);
    return { data: items, meta: offsetMetaOf(query.page, query.pageSize, total) };
  }

  async update(actorId: string, institutionId: string, input: Partial<InstitutionInput> & { status?: InstitutionStatus }, meta: RequestMeta) {
    await this.requireVisible(actorId, institutionId);
    await this.authz.require(actorId, Permission.InstitutionUpdate, { institutionId });
    if (input.status || input.slug || input.customDomain !== undefined) {
      await this.authz.require(actorId, Permission.InstitutionCreate);
    }
    try {
      const updated = await this.db.institution.update({
        where: { id: institutionId },
        data: {
          ...(input.slug ? { slug: input.slug } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.type ? { type: input.type } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.defaultLocale ? { defaultLocale: input.defaultLocale } : {}),
          ...(input.defaultTimezone ? { defaultTimezone: input.defaultTimezone } : {}),
          ...(input.defaultCurrency ? { defaultCurrency: input.defaultCurrency } : {}),
          ...(input.customDomain !== undefined ? { customDomain: input.customDomain } : {}),
          ...(input.settings ? { settings: input.settings as Prisma.InputJsonValue } : {}),
          ...(input.branding ? { branding: input.branding as Prisma.InputJsonValue } : {}),
        },
      });
      if (input.status) await this.authz.invalidateAll();
      await this.audit.record({
        action: "institution.updated",
        category: AuditCategory.ADMINISTRATION,
        actorId,
        resourceType: "institution",
        resourceId: institutionId,
        institutionId,
        metadata: { fields: Object.keys(input) },
        meta,
      });
      return updated;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Slug or domain already in use");
      throw error;
    }
  }

  async members(actorId: string, institutionId: string, query: { page: number; pageSize: number; search?: string; memberType?: MemberType; status?: MembershipStatus }) {
    await this.authz.require(actorId, Permission.InstitutionMembersRead, { institutionId }, { hideAs: "Institution" });
    const where: Prisma.InstitutionMembershipWhereInput = {
      institutionId,
      ...(query.memberType ? { memberType: query.memberType } : {}),
      ...(query.status ? { status: query.status } : { status: { not: MembershipStatus.REMOVED } }),
      ...(query.search
        ? {
            OR: [
              { user: { email: { contains: query.search.toLowerCase() } } },
              { user: { displayName: { contains: query.search, mode: "insensitive" } } },
              { externalId: { contains: query.search } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.db.institutionMembership.findMany({
        where,
        include: { user: { select: { id: true, email: true, displayName: true, status: true } } },
        orderBy: { createdAt: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.institutionMembership.count({ where }),
    ]);
    return {
      data: items.map((item) => ({
        id: item.id,
        userId: item.userId,
        email: item.user.email,
        displayName: item.user.displayName,
        userStatus: item.user.status,
        memberType: item.memberType,
        status: item.status,
        externalId: item.externalId,
        joinedAt: item.joinedAt,
        createdAt: item.createdAt,
      })),
      meta: offsetMetaOf(query.page, query.pageSize, total),
    };
  }

  private async assertCanGrant(actorId: string, roleId: string, scope: { institutionId: string; courseId?: string | null }) {
    await this.authz.require(actorId, Permission.RoleAssign, { institutionId: scope.institutionId, courseId: scope.courseId ?? null });
    const role = await this.db.role.findUnique({ where: { id: roleId }, include: { permissions: true } });
    if (!role) throw notFound("Role");
    if (role.scope === RoleScope.PLATFORM) throw forbidden("Platform roles cannot be granted from an institution");
    if (role.institutionId && role.institutionId !== scope.institutionId) throw notFound("Role");
    if (role.scope === RoleScope.COURSE && !scope.courseId) throw badRequest(ErrorCode.VALIDATION_FAILED, "Course roles require a courseId");
    if (role.scope === RoleScope.INSTITUTION && scope.courseId) throw badRequest(ErrorCode.VALIDATION_FAILED, "Institution roles cannot target a course");
    for (const item of role.permissions) {
      const allowed = await this.authz.can(actorId, item.permission as Permission, { institutionId: scope.institutionId, courseId: scope.courseId ?? null });
      if (!allowed) throw forbidden("You cannot grant permissions you do not hold");
    }
    return role;
  }

  async invite(
    actorId: string,
    institutionId: string,
    input: { email: string; displayName: string; memberType: MemberType; externalId?: string | null },
    meta: RequestMeta,
  ) {
    const institution = await this.requireVisible(actorId, institutionId);
    await this.authz.require(actorId, Permission.InstitutionMembersManage, { institutionId });
    const roleKey = defaultRoleByMemberType[input.memberType];
    const role = roleKey ? await this.db.role.findFirst({ where: { key: roleKey, institutionId: null } }) : null;
    if (role) await this.assertCanGrant(actorId, role.id, { institutionId });

    const result = await this.db.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email: input.email } });
      let setupToken: string | null = null;
      if (!user) {
        user = await tx.user.create({
          data: {
            email: input.email,
            displayName: input.displayName,
            status: UserStatus.PENDING_VERIFICATION,
            profile: { create: {} },
            preference: { create: { locale: institution.defaultLocale, timezone: institution.defaultTimezone, currency: institution.defaultCurrency } },
          },
        });
        setupToken = (await this.tokens.issue(tx, { userId: user.id, purpose: VerificationPurpose.ACCOUNT_SETUP, ttlSeconds: ACCOUNT_SETUP_TTL_SECONDS })).token;
      }
      const existing = await tx.institutionMembership.findUnique({ where: { institutionId_userId: { institutionId, userId: user.id } } });
      if (existing && existing.status !== MembershipStatus.REMOVED) throw conflict(ErrorCode.CONFLICT, "User is already a member");
      const membership = existing
        ? await tx.institutionMembership.update({
            where: { id: existing.id },
            data: { status: MembershipStatus.ACTIVE, memberType: input.memberType, externalId: input.externalId ?? null, invitedById: actorId, joinedAt: new Date() },
          })
        : await tx.institutionMembership.create({
            data: { institutionId, userId: user.id, memberType: input.memberType, externalId: input.externalId ?? null, invitedById: actorId, status: MembershipStatus.ACTIVE, joinedAt: new Date() },
          });
      if (role) {
        await tx.roleAssignment.upsert({
          where: { userId_roleId_scopeKey: { userId: user.id, roleId: role.id, scopeKey: scopeKeyFor({ type: RoleScope.INSTITUTION, institutionId }) } },
          create: { userId: user.id, roleId: role.id, scopeType: RoleScope.INSTITUTION, scopeKey: scopeKeyFor({ type: RoleScope.INSTITUTION, institutionId }), institutionId, grantedById: actorId },
          update: {},
        });
      }
      if (setupToken) {
        const url = new URL("/account-setup", this.config.WEB_APP_URL);
        url.searchParams.set("token", setupToken);
        await this.emails.enqueue(tx, {
          template: EmailTemplate.AccountSetup,
          to: user.email,
          userId: user.id,
          locale: institution.defaultLocale,
          timezone: institution.defaultTimezone,
          values: { name: user.displayName, institution: institution.name, hours: ACCOUNT_SETUP_TTL_SECONDS / 3600 },
          actionUrl: url.toString(),
          requestId: meta.requestId,
        });
      }
      await this.audit.record(
        {
          action: "institution.member.added",
          category: AuditCategory.ADMINISTRATION,
          actorId,
          resourceType: "membership",
          resourceId: membership.id,
          institutionId,
          metadata: { memberType: input.memberType, newAccount: setupToken !== null },
          meta,
        },
        tx,
      );
      return { membershipId: membership.id, userId: user.id, invited: setupToken !== null };
    });
    await this.authz.invalidate(result.userId);
    return result;
  }

  async updateMember(
    actorId: string,
    institutionId: string,
    membershipId: string,
    input: { memberType?: MemberType; status?: MembershipStatus; externalId?: string | null },
    meta: RequestMeta,
  ) {
    await this.authz.require(actorId, Permission.InstitutionMembersManage, { institutionId }, { hideAs: "Institution" });
    const membership = await this.db.institutionMembership.findFirst({ where: { id: membershipId, institutionId } });
    if (!membership) throw notFound("Membership");
    if (membership.userId === actorId && input.status && input.status !== MembershipStatus.ACTIVE) {
      throw forbidden("You cannot suspend your own membership");
    }
    const updated = await this.db.$transaction(async (tx) => {
      const result = await tx.institutionMembership.update({
        where: { id: membershipId },
        data: {
          ...(input.memberType ? { memberType: input.memberType } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
        },
      });
      if (input.status === MembershipStatus.REMOVED) {
        await tx.roleAssignment.deleteMany({ where: { userId: membership.userId, institutionId } });
      }
      await this.audit.record(
        { action: "institution.member.updated", category: AuditCategory.ADMINISTRATION, actorId, resourceType: "membership", resourceId: membershipId, institutionId, metadata: input, meta },
        tx,
      );
      return result;
    });
    await this.authz.invalidate(membership.userId);
    return updated;
  }

  async roles(actorId: string, institutionId: string) {
    await this.authz.require(actorId, Permission.RoleRead, { institutionId }, { hideAs: "Institution" });
    const roles = await this.db.role.findMany({
      where: { OR: [{ institutionId }, { institutionId: null, scope: { in: [RoleScope.INSTITUTION, RoleScope.COURSE] } }] },
      include: { permissions: true },
      orderBy: [{ isSystem: "desc" }, { key: "asc" }],
    });
    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      scope: role.scope,
      isSystem: role.isSystem,
      institutionId: role.institutionId,
      permissions: role.permissions.map((item) => item.permission).sort(),
    }));
  }

  async createRole(actorId: string, institutionId: string, input: { key: string; name: string; description?: string; scope: RoleScope; permissions: string[] }, meta: RequestMeta) {
    await this.requireVisible(actorId, institutionId);
    await this.authz.require(actorId, Permission.RoleAssign, { institutionId }, { hideAs: "Institution" });
    if (input.scope === RoleScope.PLATFORM) throw badRequest(ErrorCode.VALIDATION_FAILED, "Custom roles cannot be platform scoped");
    const allowedSet = input.scope === RoleScope.COURSE ? courseScopedPermissions : institutionScopedPermissions;
    const invalid = input.permissions.filter((permission) => !allowedSet.has(permission));
    if (invalid.length > 0) throw badRequest(ErrorCode.VALIDATION_FAILED, "Permissions not allowed for this scope", { invalid });
    for (const permission of input.permissions) {
      if (!(await this.authz.can(actorId, permission as Permission, { institutionId }))) throw forbidden("You cannot grant permissions you do not hold");
    }
    if (systemRoles.some((role) => role.key === input.key)) throw conflict(ErrorCode.CONFLICT, "Role key reserved");
    try {
      const role = await this.db.role.create({
        data: {
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          scope: input.scope,
          institutionId,
          permissions: { create: [...new Set(input.permissions)].map((permission) => ({ permission })) },
        },
        include: { permissions: true },
      });
      await this.audit.record({ action: "role.created", category: AuditCategory.ACCESS, actorId, resourceType: "role", resourceId: role.id, institutionId, metadata: { key: role.key, permissions: input.permissions }, meta });
      return role;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Role key already exists");
      throw error;
    }
  }

  async assignRole(actorId: string, institutionId: string, input: { userId: string; roleId: string; courseId?: string | null; expiresAt?: Date | null }, meta: RequestMeta) {
    await this.requireVisible(actorId, institutionId);
    const role = await this.assertCanGrant(actorId, input.roleId, { institutionId, courseId: input.courseId ?? null });
    if (input.courseId) {
      const course = await this.db.course.findFirst({ where: { id: input.courseId, institutionId, deletedAt: null }, select: { id: true } });
      if (!course) throw notFound("Course");
    }
    if (!(await this.isActiveMember(input.userId, institutionId))) throw badRequest(ErrorCode.BUSINESS_RULE, "The user is not an active member of the institution");
    const scopeType = input.courseId ? RoleScope.COURSE : RoleScope.INSTITUTION;
    const scopeKey = scopeKeyFor({ type: scopeType, institutionId, courseId: input.courseId });
    try {
      const assignment = await this.db.roleAssignment.create({
        data: { userId: input.userId, roleId: role.id, scopeType, scopeKey, institutionId, courseId: input.courseId ?? null, grantedById: actorId, expiresAt: input.expiresAt ?? null },
      });
      await this.audit.record({
        action: "role.assigned",
        category: AuditCategory.ACCESS,
        actorId,
        resourceType: "role_assignment",
        resourceId: assignment.id,
        institutionId,
        metadata: { userId: input.userId, role: role.key, scope: scopeKey },
        meta,
      });
      await this.authz.invalidate(input.userId);
      return assignment;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Role already assigned");
      throw error;
    }
  }

  async revokeRole(actorId: string, institutionId: string, assignmentId: string, meta: RequestMeta) {
    const assignment = await this.db.roleAssignment.findFirst({ where: { id: assignmentId, institutionId } });
    if (!assignment) throw notFound("Role assignment");
    await this.authz.require(actorId, Permission.RoleAssign, { institutionId, courseId: assignment.courseId });
    if (assignment.userId === actorId) throw forbidden("You cannot revoke your own roles");
    await this.db.roleAssignment.delete({ where: { id: assignmentId } });
    await this.audit.record({ action: "role.revoked", category: AuditCategory.ACCESS, actorId, resourceType: "role_assignment", resourceId: assignmentId, institutionId, metadata: { userId: assignment.userId }, meta });
    await this.authz.invalidate(assignment.userId);
  }

  async assignments(actorId: string, institutionId: string, filter: { userId?: string; courseId?: string }) {
    await this.authz.require(actorId, Permission.RoleRead, { institutionId }, { hideAs: "Institution" });
    const assignments = await this.db.roleAssignment.findMany({
      where: { institutionId, ...(filter.userId ? { userId: filter.userId } : {}), ...(filter.courseId ? { courseId: filter.courseId } : {}) },
      include: { role: { select: { key: true, name: true } }, user: { select: { email: true, displayName: true } } },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    return assignments.map((item) => ({
      id: item.id,
      userId: item.userId,
      email: item.user.email,
      displayName: item.user.displayName,
      roleKey: item.role.key,
      roleName: item.role.name,
      scopeType: item.scopeType,
      courseId: item.courseId,
      expiresAt: item.expiresAt,
      createdAt: item.createdAt,
    }));
  }

  async createClassGroup(actorId: string, institutionId: string, input: { code: string; name: string; description?: string | null }, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.ClassGroupManage, { institutionId }, { hideAs: "Institution" });
    try {
      const group = await this.db.classGroup.create({ data: { institutionId, code: input.code, name: input.name, description: input.description ?? null } });
      await this.audit.record({ action: "class_group.created", category: AuditCategory.ACADEMIC, actorId, resourceType: "class_group", resourceId: group.id, institutionId, meta });
      return group;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(ErrorCode.CONFLICT, "Group code already exists");
      throw error;
    }
  }

  async classGroups(actorId: string, institutionId: string) {
    await this.requireVisible(actorId, institutionId);
    const canManage = await this.authz.can(actorId, Permission.ClassGroupManage, { institutionId });
    const groups = await this.db.classGroup.findMany({
      where: { institutionId, ...(canManage ? {} : { members: { some: { userId: actorId } } }) },
      include: { _count: { select: { members: true } } },
      orderBy: { code: "asc" },
    });
    return groups.map((group) => ({ id: group.id, code: group.code, name: group.name, description: group.description, members: group._count.members, createdAt: group.createdAt }));
  }

  async setClassGroupMembers(actorId: string, institutionId: string, groupId: string, members: Array<{ userId: string; role: "STUDENT" | "TUTOR" | "TEACHER" }>, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.ClassGroupManage, { institutionId }, { hideAs: "Institution" });
    const group = await this.db.classGroup.findFirst({ where: { id: groupId, institutionId } });
    if (!group) throw notFound("Group");
    const userIds = [...new Set(members.map((member) => member.userId))];
    const activeMembers = await this.db.institutionMembership.count({ where: { institutionId, userId: { in: userIds }, status: MembershipStatus.ACTIVE } });
    if (activeMembers !== userIds.length) throw badRequest(ErrorCode.BUSINESS_RULE, "All group members must be active institution members");
    await this.db.$transaction([
      this.db.classGroupMember.deleteMany({ where: { groupId } }),
      this.db.classGroupMember.createMany({ data: members.map((member) => ({ groupId, userId: member.userId, role: member.role })), skipDuplicates: true }),
    ]);
    await this.audit.record({ action: "class_group.members_set", category: AuditCategory.ACADEMIC, actorId, resourceType: "class_group", resourceId: groupId, institutionId, metadata: { count: userIds.length }, meta });
    return this.db.classGroupMember.findMany({ where: { groupId }, include: { user: { select: { displayName: true, email: true } } } });
  }
}
