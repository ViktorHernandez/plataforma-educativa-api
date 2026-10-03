import { randomBytes } from "node:crypto";
import type { Container } from "../../src/app/container.js";
import type { AppInstance } from "../../src/app/types.js";
import { scopeKeyFor } from "../../src/core/authz/authorization-service.js";
import type { RoleScope } from "../../src/generated/prisma/enums.js";
import { MemberType, MembershipStatus, UserStatus } from "../../src/generated/prisma/enums.js";
import { ensurePlatformInstitution, syncSystemRoles } from "../../src/modules/access/system-bootstrap.js";
import { json } from "./test-app.js";

export const DEFAULT_PASSWORD = "Correct-Horse-Battery-42";

let counter = 0;

export function uniqueEmail(prefix = "user"): string {
  counter += 1;
  return `${prefix}.${counter}.${randomBytes(3).toString("hex")}@example.com`;
}

export async function bootstrap(container: Container) {
  const roles = await syncSystemRoles(container.db);
  const platformInstitutionId = await ensurePlatformInstitution(container.db);
  return { roles, platformInstitutionId };
}

export async function createUser(
  container: Container,
  options: { email?: string; password?: string; displayName?: string; status?: UserStatus } = {},
) {
  const email = options.email ?? uniqueEmail();
  const password = options.password ?? DEFAULT_PASSWORD;
  const status = options.status ?? UserStatus.ACTIVE;
  const user = await container.db.user.create({
    data: {
      email,
      displayName: options.displayName ?? "Test User",
      passwordHash: await container.passwordHasher.hash(password),
      status,
      emailVerifiedAt: status === UserStatus.ACTIVE ? new Date() : null,
      profile: { create: {} },
      preference: { create: { locale: "es", timezone: "America/Mexico_City" } },
    },
  });
  return { ...user, password };
}

export async function login(app: AppInstance, email: string, password = DEFAULT_PASSWORD, headers: Record<string, string> = {}) {
  const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password }, headers });
  if (response.statusCode !== 200) throw new Error(`Login failed: ${response.statusCode} ${response.body}`);
  const body = json(response).data;
  return { accessToken: body.accessToken as string, refreshToken: body.refreshToken as string, sessionId: body.sessionId as string, body };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function createInstitution(container: Container, slug?: string) {
  return container.db.institution.create({
    data: { slug: slug ?? `inst-${randomBytes(4).toString("hex")}`, name: "Test Institution" },
  });
}

export async function addMember(container: Container, institutionId: string, userId: string, memberType: MemberType = MemberType.STUDENT) {
  return container.db.institutionMembership.create({
    data: { institutionId, userId, memberType, status: MembershipStatus.ACTIVE, joinedAt: new Date() },
  });
}

export async function grantRole(
  container: Container,
  userId: string,
  roleKey: string,
  scope: { type: RoleScope; institutionId?: string; courseId?: string },
) {
  const role = await container.db.role.findFirstOrThrow({ where: { key: roleKey, institutionId: null } });
  await container.db.roleAssignment.create({
    data: {
      userId,
      roleId: role.id,
      scopeType: scope.type,
      scopeKey: scopeKeyFor({ type: scope.type, institutionId: scope.institutionId, courseId: scope.courseId }),
      institutionId: scope.institutionId ?? null,
      courseId: scope.courseId ?? null,
    },
  });
  await container.authz.invalidate(userId);
}

export async function createUserWithSession(app: AppInstance, container: Container, options: Parameters<typeof createUser>[1] = {}) {
  const user = await createUser(container, options);
  const session = await login(app, user.email, user.password);
  return { user, ...session, headers: bearer(session.accessToken) };
}
