import { z } from "zod";
import { dataEnvelope, email, isoDateTime, password, trimmedString } from "../../core/http/schemas.js";
import { isValidTimeZone } from "../../core/i18n/translator.js";

export const tokenDelivery = z.enum(["body", "cookie"]).default("body");

export const userSummary = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean(),
});

export const authenticatedPayload = z.object({
  status: z.literal("AUTHENTICATED"),
  tokenType: z.literal("Bearer"),
  accessToken: z.string(),
  accessTokenExpiresAt: isoDateTime,
  refreshToken: z.string().optional(),
  refreshTokenExpiresAt: isoDateTime,
  csrfToken: z.string().optional(),
  sessionId: z.uuid(),
  user: userSummary,
});

export const mfaRequiredPayload = z.object({
  status: z.literal("MFA_REQUIRED"),
  challengeToken: z.string(),
  challengeExpiresAt: isoDateTime,
  methods: z.array(z.enum(["TOTP", "RECOVERY_CODE"])),
});

export const loginResponse = dataEnvelope(z.discriminatedUnion("status", [authenticatedPayload, mfaRequiredPayload]));
export const authenticatedResponse = dataEnvelope(authenticatedPayload);

export const refreshResponse = dataEnvelope(
  z.object({
    tokenType: z.literal("Bearer"),
    accessToken: z.string(),
    accessTokenExpiresAt: isoDateTime,
    refreshToken: z.string().optional(),
    refreshTokenExpiresAt: isoDateTime,
    sessionId: z.uuid(),
  }),
);

export const registerBody = z
  .object({
    email,
    password,
    displayName: trimmedString(2, 120),
    timezone: z.string().max(64).refine(isValidTimeZone, { message: "Invalid time zone" }).optional(),
    acceptTerms: z.literal(true),
  })
  .strict();

export const loginBody = z.object({ email, password, tokenDelivery }).strict();

export const mfaChallengeBody = z
  .object({
    challengeToken: z.string().min(20).max(200),
    code: z.string().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().min(10).max(20).optional(),
    tokenDelivery,
  })
  .strict()
  .refine((value) => Boolean(value.code) !== Boolean(value.recoveryCode), { message: "Provide either code or recoveryCode" });

export const tokenBody = z.object({ token: z.string().min(20).max(200) }).strict();
export const emailBody = z.object({ email }).strict();
export const refreshBody = z.object({ refreshToken: z.string().min(20).max(200).optional() }).strict();
export const passwordResetBody = z.object({ token: z.string().min(20).max(200), newPassword: password }).strict();
export const passwordChangeBody = z.object({ currentPassword: password, newPassword: password }).strict();

export const reauthSchema = z
  .object({
    password: password.optional(),
    totpCode: z.string().regex(/^\d{6}$/).optional(),
  })
  .strict();

export const mfaSetupBody = z.object({ reauth: reauthSchema.optional() }).strict();
export const mfaConfirmBody = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const mfaDisableBody = z
  .object({
    reauth: reauthSchema.optional(),
    code: z.string().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().min(10).max(20).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.code) || Boolean(value.recoveryCode), { message: "A second factor code is required" });
export const recoveryRegenerateBody = z.object({ reauth: reauthSchema.optional(), code: z.string().regex(/^\d{6}$/) }).strict();

export const mfaStatusResponse = dataEnvelope(
  z.object({
    enabled: z.boolean(),
    totp: z.object({ status: z.string(), confirmedAt: isoDateTime.nullable(), createdAt: isoDateTime }).nullable(),
    recoveryCodesRemaining: z.number().int(),
  }),
);

export const mfaSetupResponse = dataEnvelope(z.object({ secret: z.string(), otpauthUri: z.string(), qrCodeDataUrl: z.string() }));
export const recoveryCodesResponse = dataEnvelope(z.object({ recoveryCodes: z.array(z.string()) }));

export const sessionItem = z.object({
  id: z.uuid(),
  current: z.boolean(),
  active: z.boolean(),
  platform: z.string(),
  authMethod: z.string(),
  authProvider: z.string().nullable(),
  mfaVerified: z.boolean(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  device: z.object({ id: z.uuid(), name: z.string().nullable(), platform: z.string() }).nullable(),
  createdAt: isoDateTime,
  lastSeenAt: isoDateTime,
  expiresAt: isoDateTime,
  revokedAt: isoDateTime.nullable(),
  revokedReason: z.string().nullable(),
});

export const oauthProviderParams = z.object({ provider: z.string().regex(/^[a-z]{2,20}$/) }).strict();

export const oauthAuthorizeQuery = z
  .object({
    redirectUri: z.string().min(1).max(500),
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    codeChallengeMethod: z.literal("S256").default("S256"),
    intent: z.enum(["login", "link"]).default("login"),
  })
  .strict();

export const oauthCallbackQuery = z
  .object({
    code: z.string().max(2000).optional(),
    state: z.string().max(200).optional(),
    error: z.string().max(200).optional(),
    error_description: z.string().max(2000).optional(),
    scope: z.string().max(2000).optional(),
    authuser: z.string().max(20).optional(),
    prompt: z.string().max(50).optional(),
    hd: z.string().max(255).optional(),
    session_state: z.string().max(200).optional(),
    iss: z.string().max(500).optional(),
  })
  .strict();

export const oauthExchangeBody = z
  .object({
    code: z.string().min(20).max(200),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    tokenDelivery,
  })
  .strict();

export const identityItem = z.object({
  id: z.uuid(),
  provider: z.string(),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  displayName: z.string().nullable(),
  linkedAt: isoDateTime,
  lastUsedAt: isoDateTime.nullable(),
});

export const unlinkBody = z.object({ reauth: reauthSchema.optional() }).strict();

export const activityItem = z.object({
  id: z.uuid(),
  action: z.string(),
  outcome: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  occurredAt: isoDateTime,
});
