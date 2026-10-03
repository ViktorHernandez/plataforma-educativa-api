import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Database } from "../database/prisma.js";
import { MembershipStatus, RoleScope } from "../../generated/prisma/enums.js";
import { forbidden, notFound } from "../http/errors.js";
import type { RedisKeys } from "../redis/redis.js";
import type { Permission } from "./permissions.js";

export interface AccessScope {
  institutionId?: string | null;
  courseId?: string | null;
}

export interface Grant {
  roleKey: string;
  scopeType: RoleScope;
  scopeKey: string;
  institutionId: string | null;
  permissions: string[];
}

const PLATFORM_SCOPE = "platform";
const CACHE_TTL_SECONDS = 300;
const VERSION_TTL_SECONDS = 86_400;

interface CachedGrants {
  version: string;
  grants: Grant[];
}

export function scopeKeyFor(scope: { type: RoleScope; institutionId?: string | null; courseId?: string | null }): string {
  if (scope.type === RoleScope.PLATFORM) return PLATFORM_SCOPE;
  if (scope.type === RoleScope.INSTITUTION) return `institution:${scope.institutionId}`;
  return `course:${scope.courseId}`;
}

export class AuthorizationService {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly keys: RedisKeys,
    private readonly logger: Logger,
  ) {}

  private cacheKey(userId: string): string {
    return this.keys.key("authz", "grants", `{${userId}}`);
  }

  private versionKey(userId: string): string {
    return this.keys.key("authz", "version", `{${userId}}`);
  }

  private get epochKey(): string {
    return this.keys.key("authz", "epoch");
  }

  async grantsFor(userId: string): Promise<Grant[]> {
    const cacheKey = this.cacheKey(userId);
    let version: string | null = null;
    try {
      const [cached, userVersion, epoch] = await Promise.all([this.redis.get(cacheKey), this.redis.get(this.versionKey(userId)), this.redis.get(this.epochKey)]);
      version = `${epoch ?? "0"}:${userVersion ?? "0"}`;
      if (cached) {
        const entry = JSON.parse(cached) as Partial<CachedGrants>;
        if (entry.version === version && Array.isArray(entry.grants)) return entry.grants;
      }
    } catch (error) {
      this.logger.warn({ err: error }, "authorization cache read failed");
    }
    const now = new Date();
    const [assignments, memberships] = await Promise.all([
      this.db.roleAssignment.findMany({
        where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: {
          scopeType: true,
          scopeKey: true,
          institutionId: true,
          expiresAt: true,
          role: { select: { key: true, permissions: { select: { permission: true } } } },
        },
      }),
      this.db.institutionMembership.findMany({
        where: { userId, status: MembershipStatus.ACTIVE, institution: { status: "ACTIVE" } },
        select: { institutionId: true },
      }),
    ]);
    const activeInstitutions = new Set(memberships.map((membership) => membership.institutionId));
    const grants: Grant[] = assignments
      .filter((assignment) => assignment.scopeType === RoleScope.PLATFORM || (assignment.institutionId !== null && activeInstitutions.has(assignment.institutionId)))
      .map((assignment) => ({
        roleKey: assignment.role.key,
        scopeType: assignment.scopeType,
        scopeKey: assignment.scopeKey,
        institutionId: assignment.institutionId,
        permissions: assignment.role.permissions.map((item) => item.permission),
      }));
    const nearestExpiry = assignments
      .map((assignment) => assignment.expiresAt?.getTime())
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b)[0];
    const ttl = nearestExpiry ? Math.max(1, Math.min(CACHE_TTL_SECONDS, Math.floor((nearestExpiry - now.getTime()) / 1000))) : CACHE_TTL_SECONDS;
    if (version !== null) {
      try {
        const entry: CachedGrants = { version, grants };
        await this.redis.set(cacheKey, JSON.stringify(entry), "EX", ttl);
      } catch (error) {
        this.logger.warn({ err: error }, "authorization cache write failed");
      }
    }
    return grants;
  }

  async invalidate(userId: string): Promise<void> {
    try {
      await this.redis.multi().incr(this.versionKey(userId)).expire(this.versionKey(userId), VERSION_TTL_SECONDS).del(this.cacheKey(userId)).exec();
    } catch (error) {
      this.logger.warn({ err: error }, "authorization cache invalidation failed");
    }
  }

  async invalidateAll(): Promise<void> {
    try {
      await this.redis.incr(this.epochKey);
    } catch (error) {
      this.logger.warn({ err: error }, "authorization cache epoch bump failed");
    }
  }

  static applicableScopeKeys(scope: AccessScope): string[] {
    const keys = [PLATFORM_SCOPE];
    if (scope.institutionId) keys.push(`institution:${scope.institutionId}`);
    if (scope.courseId) keys.push(`course:${scope.courseId}`);
    return keys;
  }

  async can(userId: string, permission: Permission, scope: AccessScope = {}): Promise<boolean> {
    const grants = await this.grantsFor(userId);
    const applicable = new Set(AuthorizationService.applicableScopeKeys(scope));
    return grants.some((grant) => applicable.has(grant.scopeKey) && grant.permissions.includes(permission));
  }

  async require(userId: string, permission: Permission, scope: AccessScope = {}, options: { hideAs?: string } = {}): Promise<void> {
    if (await this.can(userId, permission, scope)) return;
    if (options.hideAs) throw notFound(options.hideAs);
    throw forbidden();
  }

  async hasPlatformPermission(userId: string, permission: Permission): Promise<boolean> {
    const grants = await this.grantsFor(userId);
    return grants.some((grant) => grant.scopeKey === PLATFORM_SCOPE && grant.permissions.includes(permission));
  }

  async institutionsWithPermission(userId: string, permission: Permission): Promise<"all" | string[]> {
    const grants = await this.grantsFor(userId);
    if (grants.some((grant) => grant.scopeKey === PLATFORM_SCOPE && grant.permissions.includes(permission))) return "all";
    return [
      ...new Set(
        grants
          .filter((grant) => grant.scopeType === RoleScope.INSTITUTION && grant.permissions.includes(permission) && grant.institutionId)
          .map((grant) => grant.institutionId!),
      ),
    ];
  }

  async coursesWithPermission(userId: string, permission: Permission): Promise<string[]> {
    const grants = await this.grantsFor(userId);
    return grants
      .filter((grant) => grant.scopeType === RoleScope.COURSE && grant.permissions.includes(permission))
      .map((grant) => grant.scopeKey.slice("course:".length));
  }

  async effectivePermissions(userId: string): Promise<Array<{ scope: string; role: string; permissions: string[] }>> {
    const grants = await this.grantsFor(userId);
    return grants.map((grant) => ({ scope: grant.scopeKey, role: grant.roleKey, permissions: grant.permissions }));
  }
}
