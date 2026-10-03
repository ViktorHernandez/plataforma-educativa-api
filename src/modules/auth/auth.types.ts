import type { AuthMethod, OAuthProvider } from "../../generated/prisma/enums.js";
import type { IssuedSession } from "./session.service.js";

export type TokenDelivery = "body" | "cookie";

export interface AuthenticatedUserSummary {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
}

export interface AuthenticatedResult {
  status: "AUTHENTICATED";
  session: IssuedSession;
  user: AuthenticatedUserSummary;
}

export interface MfaRequiredResult {
  status: "MFA_REQUIRED";
  challengeToken: string;
  challengeExpiresAt: Date;
  methods: Array<"TOTP" | "RECOVERY_CODE">;
}

export type LoginResult = AuthenticatedResult | MfaRequiredResult;

export interface LoginChallengeContext {
  authMethod: AuthMethod;
  provider: OAuthProvider | null;
}
