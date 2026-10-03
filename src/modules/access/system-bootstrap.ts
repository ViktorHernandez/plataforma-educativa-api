import type { Database } from "../../core/database/prisma.js";
import { systemRoles } from "../../core/authz/permissions.js";
import { InstitutionType } from "../../generated/prisma/enums.js";

export const PLATFORM_INSTITUTION_SLUG = "platform";

export async function syncSystemRoles(db: Database): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const definition of systemRoles) {
    const existing = await db.role.findFirst({ where: { key: definition.key, institutionId: null } });
    const role = existing
      ? await db.role.update({
          where: { id: existing.id },
          data: { name: definition.name, description: definition.description, scope: definition.scope, isSystem: true },
        })
      : await db.role.create({
          data: { key: definition.key, name: definition.name, description: definition.description, scope: definition.scope, isSystem: true },
        });
    await db.$transaction([
      db.rolePermission.deleteMany({ where: { roleId: role.id, permission: { notIn: definition.permissions } } }),
      db.rolePermission.createMany({ data: definition.permissions.map((permission) => ({ roleId: role.id, permission })), skipDuplicates: true }),
    ]);
    ids.set(definition.key, role.id);
  }
  return ids;
}

export async function ensurePlatformInstitution(db: Database): Promise<string> {
  const institution = await db.institution.upsert({
    where: { slug: PLATFORM_INSTITUTION_SLUG },
    create: { slug: PLATFORM_INSTITUTION_SLUG, name: "Plataforma", type: InstitutionType.PLATFORM, isPlatform: true },
    update: {},
  });
  return institution.id;
}
