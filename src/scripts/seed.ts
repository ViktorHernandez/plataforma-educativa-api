import { createContainer, type Container } from "../app/container.js";
import { closeInfrastructure, createInfrastructure } from "../app/infrastructure.js";
import { loadConfig } from "../config/env.js";
import { scopeKeyFor } from "../core/authz/authorization-service.js";
import { SystemRole } from "../core/authz/permissions.js";
import { EmailTemplate } from "../core/mail/templates.js";
import { RoleScope, UserStatus, VerificationPurpose } from "../generated/prisma/enums.js";
import { ensurePlatformInstitution, syncSystemRoles } from "../modules/access/system-bootstrap.js";
import { resolveDemoTarget, seedDemoData } from "./demo-data.js";

async function assignRole(container: Container, userId: string, roleKey: string, scope: { type: RoleScope; institutionId?: string; courseId?: string }) {
  const role = await container.db.role.findFirstOrThrow({ where: { key: roleKey, institutionId: null } });
  const scopeKey = scopeKeyFor({ type: scope.type, institutionId: scope.institutionId, courseId: scope.courseId });
  await container.db.roleAssignment.upsert({
    where: { userId_roleId_scopeKey: { userId, roleId: role.id, scopeKey } },
    create: { userId, roleId: role.id, scopeType: scope.type, scopeKey, institutionId: scope.institutionId ?? null, courseId: scope.courseId ?? null },
    update: {},
  });
}

async function bootstrapProductionAdmin(container: Container, email: string) {
  const admins = await container.db.roleAssignment.count({ where: { role: { key: SystemRole.PlatformAdmin } } });
  if (admins > 0) {
    console.log("A platform administrator already exists, skipping admin bootstrap");
    return;
  }
  const user =
    (await container.db.user.findUnique({ where: { email } })) ??
    (await container.db.user.create({
      data: { email, displayName: "Administrador", status: UserStatus.PENDING_VERIFICATION, profile: { create: {} }, preference: { create: {} } },
    }));
  await assignRole(container, user.id, SystemRole.PlatformAdmin, { type: RoleScope.PLATFORM });
  await container.db.$transaction(async (tx) => {
    const { token } = await container.verificationTokens.issue(tx, { userId: user.id, purpose: VerificationPurpose.ACCOUNT_SETUP, ttlSeconds: 72 * 3600 });
    const url = new URL("/account-setup", container.config.WEB_APP_URL);
    url.searchParams.set("token", token);
    await container.emailQueue.enqueue(tx, {
      template: EmailTemplate.AccountSetup,
      to: email,
      userId: user.id,
      locale: "es",
      values: { name: user.displayName, institution: "Plataforma", hours: 72 },
      actionUrl: url.toString(),
    });
  });
  console.log(`Platform administrator invited: ${email}. The worker will send the account setup email.`);
}

async function main() {
  const config = loadConfig();
  const demoTarget = process.env["SEED_DEMO"] === "true" ? resolveDemoTarget(config) : null;
  const infra = createInfrastructure(config);
  const container = createContainer(infra);
  try {
    await syncSystemRoles(container.db);
    await ensurePlatformInstitution(container.db);
    console.log("System roles and platform institution are up to date");
    if (demoTarget) {
      const summary = await seedDemoData(container, demoTarget);
      console.log(`Demo data ready in ${summary.database}. Run npm run demo:status for details.`);
    } else if (process.env["SEED_ADMIN_EMAIL"]) {
      await bootstrapProductionAdmin(container, process.env["SEED_ADMIN_EMAIL"].toLowerCase());
    }
  } finally {
    await closeInfrastructure(infra);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
