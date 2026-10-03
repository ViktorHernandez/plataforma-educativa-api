import type { AppConfig } from "../../config/env.js";
import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import type { AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import { isUniqueViolation } from "../../core/database/prisma.js";
import { ErrorCode, badRequest, conflict, notFound } from "../../core/http/errors.js";
import type { ClientInfo, RequestMeta } from "../../core/http/request-context.js";
import type { EmailQueue } from "../../core/mail/email-queue.js";
import { EmailTemplate } from "../../core/mail/templates.js";
import type { RateLimitService } from "../../core/security/rate-limiter.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { PushProvider as PushProviderEnum } from "../../generated/prisma/enums.js";
import { decodeBase64Url, isAllowedPushEndpoint, isValidP256PublicKey } from "../../core/push/web-push.js";
import {
  FilePurpose,
  FileStatus,
  MembershipStatus,
  SessionRevocationReason,
  ThemePreference,
  UserStatus,
  VerificationPurpose,
} from "../../generated/prisma/enums.js";
import type { SessionService } from "../auth/session.service.js";
import type { VerificationTokenService } from "../auth/verification-token.service.js";
import {
  accessibilityPreferences,
  interfacePreferences,
  privacyPreferences,
  resolvePreferenceGroup,
  type PrivacyPreferences,
} from "./preference-schemas.js";

export interface ProfileUpdate {
  displayName?: string;
  firstName?: string | null;
  lastName?: string | null;
  headline?: string | null;
  bio?: string | null;
  pronouns?: string | null;
  country?: string | null;
  websiteUrl?: string | null;
  organization?: string | null;
  academicLevel?: string | null;
  fieldOfStudy?: string | null;
  avatarFileId?: string | null;
}

export interface PreferenceUpdate {
  locale?: string;
  timezone?: string;
  currency?: string;
  theme?: ThemePreference;
  accessibility?: Record<string, unknown>;
  interface?: Record<string, unknown>;
  privacy?: Record<string, unknown>;
}

const EMAIL_CHANGE_TTL_SECONDS = 24 * 3600;

export type PushSubscriptionInput =
  | { provider: "FCM"; token: string }
  | { provider: "WEB_PUSH"; endpoint: string; keys: { p256dh: string; auth: string } };

export class UserService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly tokens: VerificationTokenService,
    private readonly emails: EmailQueue,
    private readonly rateLimits: RateLimitService,
  ) {}

  async me(userId: string) {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        profile: true,
        preference: true,
        memberships: {
          where: { status: MembershipStatus.ACTIVE },
          include: { institution: { select: { id: true, slug: true, name: true, type: true, isPlatform: true } } },
        },
      },
    });
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      emailVerified: user.emailVerifiedAt !== null,
      mfaEnabled: user.mfaEnabled,
      hasPassword: user.passwordHash !== null,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      profile: this.presentProfile(user.profile),
      preferences: this.presentPreferences(user.preference),
      memberships: user.memberships.map((membership) => ({
        institutionId: membership.institutionId,
        institutionSlug: membership.institution.slug,
        institutionName: membership.institution.name,
        memberType: membership.memberType,
        joinedAt: membership.joinedAt,
      })),
    };
  }

  presentProfile(profile: Prisma.UserProfileGetPayload<object> | null) {
    return {
      firstName: profile?.firstName ?? null,
      lastName: profile?.lastName ?? null,
      headline: profile?.headline ?? null,
      bio: profile?.bio ?? null,
      pronouns: profile?.pronouns ?? null,
      country: profile?.country ?? null,
      websiteUrl: profile?.websiteUrl ?? null,
      organization: profile?.organization ?? null,
      academicLevel: profile?.academicLevel ?? null,
      fieldOfStudy: profile?.fieldOfStudy ?? null,
      avatarFileId: profile?.avatarFileId ?? null,
    };
  }

  presentPreferences(preference: Prisma.UserPreferenceGetPayload<object> | null) {
    return {
      locale: preference?.locale ?? "es",
      timezone: preference?.timezone ?? "UTC",
      currency: preference?.currency ?? "USD",
      theme: preference?.theme ?? ThemePreference.SYSTEM,
      accessibility: resolvePreferenceGroup(accessibilityPreferences, preference?.accessibility),
      interface: resolvePreferenceGroup(interfacePreferences, preference?.interface),
      privacy: resolvePreferenceGroup(privacyPreferences, preference?.privacy),
    };
  }

  async updateProfile(userId: string, update: ProfileUpdate, meta: RequestMeta) {
    if (update.avatarFileId) {
      const file = await this.db.file.findFirst({
        where: { id: update.avatarFileId, ownerId: userId, purpose: FilePurpose.AVATAR, status: FileStatus.READY, deletedAt: null },
      });
      if (!file) throw badRequest(ErrorCode.VALIDATION_FAILED, "Avatar file is not available");
    }
    const { displayName, ...profileFields } = update;
    await this.db.$transaction(async (tx) => {
      if (displayName) await tx.user.update({ where: { id: userId }, data: { displayName } });
      if (Object.keys(profileFields).length > 0) {
        await tx.userProfile.upsert({ where: { userId }, create: { userId, ...profileFields }, update: profileFields });
      }
      await this.audit.record(
        { action: "user.profile.updated", category: AuditCategory.DATA, actorId: userId, resourceType: "user", resourceId: userId, metadata: { fields: Object.keys(update) }, meta },
        tx,
      );
    });
    return this.me(userId);
  }

  async preferences(userId: string) {
    const preference = await this.db.userPreference.findUnique({ where: { userId } });
    return this.presentPreferences(preference);
  }

  async updatePreferences(userId: string, update: PreferenceUpdate) {
    const current = await this.preferences(userId);
    const accessibility = update.accessibility ? accessibilityPreferences.parse({ ...current.accessibility, ...update.accessibility }) : current.accessibility;
    const interfaceGroup = update.interface ? interfacePreferences.parse({ ...current.interface, ...update.interface }) : current.interface;
    const privacy = update.privacy ? privacyPreferences.parse({ ...current.privacy, ...update.privacy }) : current.privacy;
    const data = {
      locale: update.locale ?? current.locale,
      timezone: update.timezone ?? current.timezone,
      currency: update.currency ?? current.currency,
      theme: update.theme ?? current.theme,
      accessibility: accessibility as Prisma.InputJsonValue,
      interface: interfaceGroup as Prisma.InputJsonValue,
      privacy: privacy as Prisma.InputJsonValue,
    };
    const saved = await this.db.userPreference.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    return this.presentPreferences(saved);
  }

  async privacyOf(userId: string): Promise<PrivacyPreferences> {
    const preference = await this.db.userPreference.findUnique({ where: { userId }, select: { privacy: true } });
    return resolvePreferenceGroup(privacyPreferences, preference?.privacy);
  }

  async sharesActiveInstitution(userA: string, userB: string): Promise<boolean> {
    const count = await this.db.institutionMembership.count({
      where: {
        userId: userA,
        status: MembershipStatus.ACTIVE,
        institution: { isPlatform: false, memberships: { some: { userId: userB, status: MembershipStatus.ACTIVE } } },
      },
    });
    return count > 0;
  }

  async publicProfile(viewerId: string, userId: string) {
    const user = await this.db.user.findFirst({
      where: { id: userId, deletedAt: null, status: { in: [UserStatus.ACTIVE, UserStatus.PENDING_VERIFICATION] } },
      include: { profile: true, preference: { select: { privacy: true } } },
    });
    if (!user) throw notFound("User");
    const privacy = resolvePreferenceGroup(privacyPreferences, user.preference?.privacy);
    const isSelf = viewerId === userId;
    const isAdmin = await this.authz.hasPlatformPermission(viewerId, Permission.UserRead);
    let visible = isSelf || isAdmin || privacy.profileVisibility === "public";
    if (!visible && privacy.profileVisibility === "institution") visible = await this.sharesActiveInstitution(viewerId, userId);
    if (!visible) throw notFound("User");
    return {
      id: user.id,
      displayName: user.displayName,
      headline: user.profile?.headline ?? null,
      bio: user.profile?.bio ?? null,
      pronouns: user.profile?.pronouns ?? null,
      country: user.profile?.country ?? null,
      websiteUrl: user.profile?.websiteUrl ?? null,
      organization: user.profile?.organization ?? null,
      avatarFileId: user.profile?.avatarFileId ?? null,
    };
  }

  async devices(userId: string) {
    const devices = await this.db.userDevice.findMany({
      where: { userId },
      orderBy: { lastSeenAt: "desc" },
      include: { _count: { select: { sessions: { where: { revokedAt: null } } } } },
    });
    return devices.map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform,
      userAgent: device.userAgent,
      lastIp: device.lastIp,
      firstSeenAt: device.firstSeenAt,
      lastSeenAt: device.lastSeenAt,
      activeSessions: device._count.sessions,
    }));
  }

  async removeDevice(userId: string, deviceId: string, meta: RequestMeta) {
    const device = await this.db.userDevice.findFirst({ where: { id: deviceId, userId } });
    if (!device) throw notFound("Device");
    const sessions = await this.db.session.findMany({ where: { deviceId, revokedAt: null }, select: { id: true } });
    for (const session of sessions) await this.sessions.revoke(session.id, SessionRevocationReason.USER_REVOKED);
    await this.db.$transaction([
      this.db.pushSubscription.updateMany({ where: { deviceId, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.db.userDevice.delete({ where: { id: deviceId } }),
    ]);
    await this.audit.record({ action: "user.device.removed", category: AuditCategory.SECURITY, actorId: userId, resourceType: "device", resourceId: deviceId, meta });
  }

  async registerPushSubscription(userId: string, sessionId: string, input: PushSubscriptionInput, client: ClientInfo) {
    const session = await this.db.session.findUnique({ where: { id: sessionId }, select: { deviceId: true } });
    let token: string;
    let keys: { p256dh: string | null; authSecret: string | null } = { p256dh: null, authSecret: null };
    if (input.provider === PushProviderEnum.WEB_PUSH) {
      if (!isAllowedPushEndpoint(input.endpoint, this.config.WEB_PUSH_ALLOWED_HOSTS)) throw badRequest(ErrorCode.VALIDATION_FAILED, "Push endpoint is not an allowed push service");
      if (!isValidP256PublicKey(decodeBase64Url(input.keys.p256dh)) || decodeBase64Url(input.keys.auth).length !== 16) throw badRequest(ErrorCode.VALIDATION_FAILED, "Invalid web push keys");
      token = input.endpoint;
      keys = { p256dh: input.keys.p256dh, authSecret: input.keys.auth };
    } else {
      token = input.token;
    }
    const data = { userId, deviceId: session?.deviceId ?? null, provider: input.provider, platform: client.platform, ...keys, failureCount: 0, lastFailureAt: null };
    const subscription = await this.db.pushSubscription.upsert({
      where: { token },
      create: { ...data, token },
      update: { ...data, revokedAt: null },
    });
    return { id: subscription.id, provider: subscription.provider, platform: subscription.platform, createdAt: subscription.createdAt };
  }

  async removePushSubscription(userId: string, subscriptionId: string) {
    const result = await this.db.pushSubscription.updateMany({ where: { id: subscriptionId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (result.count === 0) throw notFound("Push subscription");
  }

  async requestEmailChange(userId: string, newEmail: string, meta: RequestMeta) {
    await this.rateLimits.consume("sensitiveUser", userId);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId }, include: { preference: true } });
    if (user.email === newEmail) throw badRequest(ErrorCode.VALIDATION_FAILED, "The new email is the current email");
    const taken = await this.db.user.findUnique({ where: { email: newEmail }, select: { id: true } });
    if (taken) return;
    await this.db.$transaction(async (tx) => {
      const { token } = await this.tokens.issue(tx, { userId, purpose: VerificationPurpose.EMAIL_CHANGE, ttlSeconds: EMAIL_CHANGE_TTL_SECONDS, metadata: { newEmail } });
      const url = new URL("/confirm-email-change", this.config.WEB_APP_URL);
      url.searchParams.set("token", token);
      await this.emails.enqueue(tx, {
        template: EmailTemplate.EmailChange,
        to: newEmail,
        userId,
        locale: user.preference?.locale ?? "es",
        timezone: user.preference?.timezone,
        values: { name: user.displayName, hours: EMAIL_CHANGE_TTL_SECONDS / 3600 },
        actionUrl: url.toString(),
        requestId: meta.requestId,
      });
      await this.audit.record({ action: "user.email.change_requested", category: AuditCategory.SECURITY, actorId: userId, meta }, tx);
    });
  }

  async confirmEmailChange(userId: string, sessionId: string, token: string, meta: RequestMeta) {
    const updated = await this.db.$transaction(async (tx) => {
      const consumed = await this.tokens.consume(tx, token, VerificationPurpose.EMAIL_CHANGE);
      if (!consumed || consumed.userId !== userId) throw badRequest(ErrorCode.TOKEN_ALREADY_USED, "Invalid or expired token");
      const newEmail = typeof consumed.metadata["newEmail"] === "string" ? consumed.metadata["newEmail"] : "";
      if (!newEmail) throw badRequest(ErrorCode.TOKEN_ALREADY_USED, "Invalid or expired token");
      const previous = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, displayName: true, preference: true } });
      try {
        await tx.user.update({ where: { id: userId }, data: { email: newEmail, emailVerifiedAt: new Date() } });
      } catch (error) {
        if (isUniqueViolation(error, "email")) throw conflict(ErrorCode.CONFLICT, "Email already in use");
        throw error;
      }
      await this.emails.enqueue(tx, {
        template: EmailTemplate.SecurityAlert,
        to: previous.email,
        userId,
        locale: previous.preference?.locale ?? "es",
        timezone: previous.preference?.timezone,
        values: { name: previous.displayName },
        dateValues: { date: new Date().toISOString() },
        requestId: meta.requestId,
      });
      await this.audit.record({ action: "user.email.changed", category: AuditCategory.SECURITY, actorId: userId, meta }, tx);
      return newEmail;
    });
    await this.sessions.revokeAll(userId, SessionRevocationReason.SECURITY, sessionId);
    return updated;
  }

  async integrations(userId: string) {
    return this.db.integrationConnection.findMany({
      where: { userId },
      select: { id: true, provider: true, status: true, externalAccountEmail: true, scopes: true, expiresAt: true, syncEnabled: true, lastSyncedAt: true, lastError: true, createdAt: true, updatedAt: true },
    });
  }

  async removeIntegration(userId: string, integrationId: string, meta: RequestMeta) {
    const result = await this.db.integrationConnection.deleteMany({ where: { id: integrationId, userId } });
    if (result.count === 0) throw notFound("Integration");
    await this.audit.record({ action: "user.integration.removed", category: AuditCategory.SECURITY, actorId: userId, resourceType: "integration", resourceId: integrationId, meta });
  }

  async deactivate(userId: string, meta: RequestMeta) {
    await this.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { status: UserStatus.DEACTIVATED } });
      await tx.pushSubscription.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record({ action: "user.account.deactivated", category: AuditCategory.SECURITY, actorId: userId, meta }, tx);
    });
    await this.sessions.revokeAll(userId, SessionRevocationReason.ACCOUNT_DEACTIVATED);
    await this.authz.invalidate(userId);
  }
}
