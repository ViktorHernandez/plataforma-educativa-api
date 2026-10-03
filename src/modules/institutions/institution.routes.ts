import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { dataEnvelope, email, isoDateTime, offsetPage, offsetQuery, okResponse, slug, standardErrors, trimmedString } from "../../core/http/schemas.js";
import { isValidCurrency, isValidTimeZone, SUPPORTED_LOCALES } from "../../core/i18n/translator.js";
import { InstitutionStatus, InstitutionType, MemberType, MembershipStatus, RoleScope } from "../../generated/prisma/enums.js";

const tags = ["Institutions"];
const security = [{ bearerAuth: [] }];

const institutionSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  type: z.enum(InstitutionType),
  status: z.enum(InstitutionStatus),
  isPlatform: z.boolean(),
  defaultLocale: z.string(),
  defaultTimezone: z.string(),
  defaultCurrency: z.string(),
  customDomain: z.string().nullable(),
  settings: z.record(z.string(), z.unknown()),
  branding: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

type InstitutionRow = Omit<z.infer<typeof institutionSchema>, "settings" | "branding"> & { settings: unknown; branding: unknown };

function presentInstitution(row: InstitutionRow): z.infer<typeof institutionSchema> {
  const asObject = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  return { ...row, settings: asObject(row.settings), branding: asObject(row.branding) };
}

const jsonObject = z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 20_000, { message: "Object too large" });

const institutionBody = z
  .object({
    slug,
    name: trimmedString(2, 160),
    type: z.enum(InstitutionType).optional(),
    defaultLocale: z.enum(SUPPORTED_LOCALES).optional(),
    defaultTimezone: z.string().refine(isValidTimeZone, { message: "Invalid time zone" }).optional(),
    defaultCurrency: z.string().refine(isValidCurrency, { message: "Invalid currency" }).optional(),
    customDomain: z.string().regex(/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/).nullable().optional(),
    settings: jsonObject.optional(),
    branding: jsonObject.optional(),
  })
  .strict();

const institutionParams = z.object({ institutionId: z.uuid() }).strict();

const memberSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  userStatus: z.string(),
  memberType: z.enum(MemberType),
  status: z.enum(MembershipStatus),
  externalId: z.string().nullable(),
  joinedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});

const roleSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scope: z.enum(RoleScope),
  isSystem: z.boolean(),
  institutionId: z.uuid().nullable(),
  permissions: z.array(z.string()),
});

export function registerInstitutionRoutes(app: AppInstance, container: Container): void {
  const { institutions, authenticator } = container;

  app.post(
    "/institutions",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Create an institution", body: institutionBody, response: { 201: dataEnvelope(institutionSchema), ...standardErrors } } },
    async (request, reply) => {
      reply.code(201);
      return { data: presentInstitution(await institutions.create(requireAuth(request).userId, request.body, requestMeta(request))) };
    },
  );

  app.get(
    "/institutions",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Institutions visible to the current user",
        querystring: offsetQuery.extend({ search: z.string().trim().max(100).optional(), status: z.enum(InstitutionStatus).optional() }).strict(),
        response: { 200: offsetPage(institutionSchema), ...standardErrors },
      },
    },
    async (request) => {
      const result = await institutions.list(requireAuth(request).userId, request.query);
      return { data: result.data.map(presentInstitution), meta: result.meta };
    },
  );

  app.get(
    "/institutions/:institutionId",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Institution detail", params: institutionParams, response: { 200: dataEnvelope(institutionSchema), ...standardErrors } } },
    async (request) => ({ data: presentInstitution(await institutions.requireVisible(requireAuth(request).userId, request.params.institutionId)) }),
  );

  app.patch(
    "/institutions/:institutionId",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Update an institution",
        params: institutionParams,
        body: institutionBody.partial().extend({ status: z.enum(InstitutionStatus).optional() }).strict(),
        response: { 200: dataEnvelope(institutionSchema), ...standardErrors },
      },
    },
    async (request) => ({
      data: presentInstitution(await institutions.update(requireAuth(request).userId, request.params.institutionId, request.body, requestMeta(request))),
    }),
  );

  app.get(
    "/institutions/:institutionId/members",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Institution members",
        params: institutionParams,
        querystring: offsetQuery.extend({ search: z.string().trim().max(100).optional(), memberType: z.enum(MemberType).optional(), status: z.enum(MembershipStatus).optional() }).strict(),
        response: { 200: offsetPage(memberSchema), ...standardErrors },
      },
    },
    async (request) => institutions.members(requireAuth(request).userId, request.params.institutionId, request.query),
  );

  app.post(
    "/institutions/:institutionId/members",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Add or invite a member",
        params: institutionParams,
        body: z.object({ email, displayName: trimmedString(2, 120), memberType: z.enum(MemberType), externalId: z.string().trim().max(80).nullable().optional() }).strict(),
        response: { 201: dataEnvelope(z.object({ membershipId: z.uuid(), userId: z.uuid(), invited: z.boolean() })), ...standardErrors },
      },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await institutions.invite(requireAuth(request).userId, request.params.institutionId, request.body, requestMeta(request)) };
    },
  );

  app.patch(
    "/institutions/:institutionId/members/:membershipId",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Update a membership",
        params: z.object({ institutionId: z.uuid(), membershipId: z.uuid() }).strict(),
        body: z.object({ memberType: z.enum(MemberType).optional(), status: z.enum(MembershipStatus).optional(), externalId: z.string().trim().max(80).nullable().optional() }).strict(),
        response: { 200: okResponse, ...standardErrors },
      },
    },
    async (request) => {
      await institutions.updateMember(requireAuth(request).userId, request.params.institutionId, request.params.membershipId, request.body, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.get(
    "/institutions/:institutionId/roles",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Roles available in the institution", params: institutionParams, response: { 200: dataEnvelope(z.array(roleSchema)), ...standardErrors } } },
    async (request) => ({ data: await institutions.roles(requireAuth(request).userId, request.params.institutionId) }),
  );

  app.post(
    "/institutions/:institutionId/roles",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Create a custom role",
        params: institutionParams,
        body: z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9_]{2,59}$/),
            name: trimmedString(2, 120),
            description: z.string().trim().max(500).optional(),
            scope: z.enum([RoleScope.INSTITUTION, RoleScope.COURSE]),
            permissions: z.array(z.string().max(100)).min(1).max(60),
          })
          .strict(),
        response: { 201: dataEnvelope(z.object({ id: z.uuid(), key: z.string() })), ...standardErrors },
      },
    },
    async (request, reply) => {
      const role = await institutions.createRole(requireAuth(request).userId, request.params.institutionId, request.body, requestMeta(request));
      reply.code(201);
      return { data: { id: role.id, key: role.key } };
    },
  );

  app.get(
    "/institutions/:institutionId/role-assignments",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Role assignments",
        params: institutionParams,
        querystring: z.object({ userId: z.uuid().optional(), courseId: z.uuid().optional() }).strict(),
        response: {
          200: dataEnvelope(
            z.array(
              z.object({
                id: z.uuid(),
                userId: z.uuid(),
                email: z.string(),
                displayName: z.string(),
                roleKey: z.string(),
                roleName: z.string(),
                scopeType: z.string(),
                courseId: z.uuid().nullable(),
                expiresAt: isoDateTime.nullable(),
                createdAt: isoDateTime,
              }),
            ),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await institutions.assignments(requireAuth(request).userId, request.params.institutionId, request.query) }),
  );

  app.post(
    "/institutions/:institutionId/role-assignments",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Assign a role",
        params: institutionParams,
        body: z.object({ userId: z.uuid(), roleId: z.uuid(), courseId: z.uuid().nullable().optional(), expiresAt: isoDateTime.nullable().optional() }).strict(),
        response: { 201: dataEnvelope(z.object({ id: z.uuid() })), ...standardErrors },
      },
    },
    async (request, reply) => {
      const assignment = await institutions.assignRole(requireAuth(request).userId, request.params.institutionId, request.body, requestMeta(request));
      reply.code(201);
      return { data: { id: assignment.id } };
    },
  );

  app.delete(
    "/institutions/:institutionId/role-assignments/:assignmentId",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Revoke a role", params: z.object({ institutionId: z.uuid(), assignmentId: z.uuid() }).strict(), response: { 200: okResponse, ...standardErrors } },
    },
    async (request) => {
      await institutions.revokeRole(requireAuth(request).userId, request.params.institutionId, request.params.assignmentId, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.get(
    "/institutions/:institutionId/class-groups",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Academic groups",
        params: institutionParams,
        response: { 200: dataEnvelope(z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string(), description: z.string().nullable(), members: z.number().int(), createdAt: isoDateTime }))), ...standardErrors },
      },
    },
    async (request) => ({ data: await institutions.classGroups(requireAuth(request).userId, request.params.institutionId) }),
  );

  app.post(
    "/institutions/:institutionId/class-groups",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Create an academic group",
        params: institutionParams,
        body: z.object({ code: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/), name: trimmedString(2, 120), description: z.string().trim().max(500).nullable().optional() }).strict(),
        response: { 201: dataEnvelope(z.object({ id: z.uuid(), code: z.string(), name: z.string() })), ...standardErrors },
      },
    },
    async (request, reply) => {
      const group = await institutions.createClassGroup(requireAuth(request).userId, request.params.institutionId, request.body, requestMeta(request));
      reply.code(201);
      return { data: { id: group.id, code: group.code, name: group.name } };
    },
  );

  app.put(
    "/institutions/:institutionId/class-groups/:groupId/members",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Replace the members of a group",
        params: z.object({ institutionId: z.uuid(), groupId: z.uuid() }).strict(),
        body: z.object({ members: z.array(z.object({ userId: z.uuid(), role: z.enum(["STUDENT", "TUTOR", "TEACHER"]) }).strict()).max(500) }).strict(),
        response: { 200: dataEnvelope(z.array(z.object({ userId: z.uuid(), role: z.string(), user: z.object({ displayName: z.string(), email: z.string() }) }))), ...standardErrors },
      },
    },
    async (request) => ({
      data: await institutions.setClassGroupMembers(requireAuth(request).userId, request.params.institutionId, request.params.groupId, request.body.members, requestMeta(request)),
    }),
  );
}
