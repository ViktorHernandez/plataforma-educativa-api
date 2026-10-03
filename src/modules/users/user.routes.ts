import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { dataEnvelope, email, httpsUrl, idParams, isoDateTime, okResponse, standardErrors, trimmedString } from "../../core/http/schemas.js";
import { isValidCurrency, isValidTimeZone, SUPPORTED_LOCALES } from "../../core/i18n/translator.js";
import { PushProvider, ThemePreference } from "../../generated/prisma/enums.js";
import { reauthSchema } from "../auth/auth.schemas.js";
import { accessibilityPreferences, interfacePreferences, privacyPreferences } from "./preference-schemas.js";

const tags = ["Me"];
const security = [{ bearerAuth: [] }];

const profileSchema = z.object({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  headline: z.string().nullable(),
  bio: z.string().nullable(),
  pronouns: z.string().nullable(),
  country: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  organization: z.string().nullable(),
  academicLevel: z.string().nullable(),
  fieldOfStudy: z.string().nullable(),
  avatarFileId: z.uuid().nullable(),
});

const preferencesSchema = z.object({
  locale: z.string(),
  timezone: z.string(),
  currency: z.string(),
  theme: z.enum(ThemePreference),
  accessibility: accessibilityPreferences,
  interface: interfacePreferences,
  privacy: privacyPreferences,
});

const meSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  status: z.string(),
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean(),
  hasPassword: z.boolean(),
  createdAt: isoDateTime,
  lastLoginAt: isoDateTime.nullable(),
  profile: profileSchema,
  preferences: preferencesSchema,
  memberships: z.array(
    z.object({
      institutionId: z.uuid(),
      institutionSlug: z.string(),
      institutionName: z.string(),
      memberType: z.string(),
      joinedAt: isoDateTime.nullable(),
    }),
  ),
});

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

const profileUpdateBody = z
  .object({
    displayName: trimmedString(2, 120).optional(),
    firstName: nullableText(80),
    lastName: nullableText(80),
    headline: nullableText(160),
    bio: nullableText(2000),
    pronouns: nullableText(40),
    country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
    websiteUrl: httpsUrl.nullable().optional(),
    organization: nullableText(160),
    academicLevel: nullableText(80),
    fieldOfStudy: nullableText(120),
    avatarFileId: z.uuid().nullable().optional(),
  })
  .strict();

const preferenceUpdateBody = z
  .object({
    locale: z.enum(SUPPORTED_LOCALES).optional(),
    timezone: z.string().max(64).refine(isValidTimeZone, { message: "Invalid time zone" }).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).refine(isValidCurrency, { message: "Invalid currency" }).optional(),
    theme: z.enum(ThemePreference).optional(),
    accessibility: accessibilityPreferences.partial().strict().optional(),
    interface: interfacePreferences.partial().strict().optional(),
    privacy: privacyPreferences.partial().strict().optional(),
  })
  .strict();

const notificationPreferenceItem = z.object({
  category: z.enum(["SECURITY", "ACADEMIC", "COMMUNICATION", "ADMINISTRATIVE", "SYSTEM"]),
  channel: z.enum(["IN_APP", "EMAIL", "PUSH"]),
  enabled: z.boolean(),
});

export function registerUserRoutes(app: AppInstance, container: Container): void {
  const { users, notifications, authenticator, authz, auth } = container;

  app.get("/me", { preHandler: authenticator.required, schema: { tags, security, summary: "Current user", response: { 200: dataEnvelope(meSchema), ...standardErrors } } }, async (request) => ({
    data: await users.me(requireAuth(request).userId),
  }));

  app.patch(
    "/me/profile",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Update profile", body: profileUpdateBody, response: { 200: dataEnvelope(meSchema), ...standardErrors } } },
    async (request) => ({ data: await users.updateProfile(requireAuth(request).userId, request.body, requestMeta(request)) }),
  );

  app.get(
    "/me/preferences",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Preferences", response: { 200: dataEnvelope(preferencesSchema), ...standardErrors } } },
    async (request) => ({ data: await users.preferences(requireAuth(request).userId) }),
  );

  app.patch(
    "/me/preferences",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Update preferences", body: preferenceUpdateBody, response: { 200: dataEnvelope(preferencesSchema), ...standardErrors } } },
    async (request) => ({ data: await users.updatePreferences(requireAuth(request).userId, request.body) }),
  );

  app.get(
    "/me/notification-preferences",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Notification preferences", response: { 200: dataEnvelope(z.array(notificationPreferenceItem.extend({ mandatory: z.boolean() }))), ...standardErrors } },
    },
    async (request) => ({ data: await notifications.preferences(requireAuth(request).userId) }),
  );

  app.put(
    "/me/notification-preferences",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Update notification preferences",
        body: z.object({ items: z.array(notificationPreferenceItem).min(1).max(15) }).strict(),
        response: { 200: dataEnvelope(z.array(notificationPreferenceItem.extend({ mandatory: z.boolean() }))), ...standardErrors },
      },
    },
    async (request) => ({ data: await notifications.updatePreferences(requireAuth(request).userId, request.body.items) }),
  );

  app.get(
    "/me/devices",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Known devices",
        response: {
          200: dataEnvelope(
            z.array(
              z.object({
                id: z.uuid(),
                name: z.string().nullable(),
                platform: z.string(),
                userAgent: z.string().nullable(),
                lastIp: z.string().nullable(),
                firstSeenAt: isoDateTime,
                lastSeenAt: isoDateTime,
                activeSessions: z.number().int(),
              }),
            ),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await users.devices(requireAuth(request).userId) }),
  );

  app.delete(
    "/me/devices/:id",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Forget a device and close its sessions", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await users.removeDevice(requireAuth(request).userId, request.params.id, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/me/push-subscriptions",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Register an FCM token or a Web Push subscription for this device",
        body: z.discriminatedUnion("provider", [
          z.object({ provider: z.literal(PushProvider.FCM), token: z.string().min(20).max(2048) }).strict(),
          z
            .object({
              provider: z.literal(PushProvider.WEB_PUSH),
              endpoint: z.url({ protocol: /^https$/ }).max(2048),
              keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/) }).strict(),
            })
            .strict(),
        ]),
        response: { 201: dataEnvelope(z.object({ id: z.uuid(), provider: z.string(), platform: z.string(), createdAt: isoDateTime })), ...standardErrors },
      },
    },
    async (request, reply) => {
      const current = requireAuth(request);
      reply.code(201);
      return { data: await users.registerPushSubscription(current.userId, current.sessionId, request.body, request.client) };
    },
  );

  app.delete(
    "/me/push-subscriptions/:id",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Remove a push token", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await users.removePushSubscription(requireAuth(request).userId, request.params.id);
      return { data: { ok: true as const } };
    },
  );

  app.get(
    "/me/permissions",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Effective roles and permissions",
        response: { 200: dataEnvelope(z.array(z.object({ scope: z.string(), role: z.string(), permissions: z.array(z.string()) }))), ...standardErrors },
      },
    },
    async (request) => ({ data: await authz.effectivePermissions(requireAuth(request).userId) }),
  );

  app.post(
    "/me/email-change",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Request an email change", body: z.object({ newEmail: email, reauth: reauthSchema.optional() }).strict(), response: { 202: dataEnvelope(z.object({ accepted: z.literal(true) })), ...standardErrors } },
    },
    async (request, reply) => {
      const current = requireAuth(request);
      await auth.verifyReauthentication(current.userId, current.authenticatedAt, request.body.reauth, requestMeta(request));
      await users.requestEmailChange(current.userId, request.body.newEmail, requestMeta(request));
      reply.code(202);
      return { data: { accepted: true as const } };
    },
  );

  app.post(
    "/me/email-change/confirm",
    {
      preHandler: authenticator.required,
      schema: { tags, security, summary: "Confirm an email change", body: z.object({ token: z.string().min(20).max(200) }).strict(), response: { 200: dataEnvelope(z.object({ email: z.string() })), ...standardErrors } },
    },
    async (request) => {
      const current = requireAuth(request);
      return { data: { email: await users.confirmEmailChange(current.userId, current.sessionId, request.body.token, requestMeta(request)) } };
    },
  );

  app.get(
    "/me/integrations",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Connected integrations",
        response: {
          200: dataEnvelope(
            z.array(
              z.object({
                id: z.uuid(),
                provider: z.string(),
                status: z.string(),
                externalAccountEmail: z.string().nullable(),
                scopes: z.array(z.string()),
                expiresAt: isoDateTime.nullable(),
                syncEnabled: z.boolean(),
                lastSyncedAt: isoDateTime.nullable(),
                lastError: z.string().nullable(),
                createdAt: isoDateTime,
                updatedAt: isoDateTime,
              }),
            ),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await users.integrations(requireAuth(request).userId) }),
  );

  app.delete(
    "/me/integrations/:id",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Disconnect an integration", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await users.removeIntegration(requireAuth(request).userId, request.params.id, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.post(
    "/me/deactivate",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Deactivate the account", body: z.object({ reauth: reauthSchema.optional() }).strict(), response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      const current = requireAuth(request);
      await auth.verifyReauthentication(current.userId, current.authenticatedAt, request.body.reauth, requestMeta(request));
      await users.deactivate(current.userId, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  app.get(
    "/users/:id",
    {
      preHandler: authenticator.required,
      schema: {
        tags: ["Users"],
        security,
        summary: "Public profile respecting privacy settings",
        params: idParams,
        response: {
          200: dataEnvelope(
            z.object({
              id: z.uuid(),
              displayName: z.string(),
              headline: z.string().nullable(),
              bio: z.string().nullable(),
              pronouns: z.string().nullable(),
              country: z.string().nullable(),
              websiteUrl: z.string().nullable(),
              organization: z.string().nullable(),
              avatarFileId: z.uuid().nullable(),
            }),
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => ({ data: await users.publicProfile(requireAuth(request).userId, request.params.id) }),
  );

  app.get(
    "/push/web/config",
    {
      schema: {
        tags: ["Notifications"],
        summary: "Public VAPID key for browser push subscriptions",
        response: { 200: dataEnvelope(z.object({ enabled: z.boolean(), publicKey: z.string().nullable() })) },
      },
    },
    () => ({ data: { enabled: container.push.isEnabled("WEB_PUSH"), publicKey: container.push.isEnabled("WEB_PUSH") ? (container.config.VAPID_PUBLIC_KEY ?? null) : null } }),
  );
}
