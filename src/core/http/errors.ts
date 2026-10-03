export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  TOKEN_INVALID: "TOKEN_INVALID",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  SESSION_REVOKED: "SESSION_REVOKED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  MFA_REQUIRED: "MFA_REQUIRED",
  MFA_INVALID: "MFA_INVALID",
  MFA_ALREADY_ENABLED: "MFA_ALREADY_ENABLED",
  MFA_NOT_ENABLED: "MFA_NOT_ENABLED",
  REAUTHENTICATION_REQUIRED: "REAUTHENTICATION_REQUIRED",
  PASSWORD_POLICY: "PASSWORD_POLICY",
  PASSWORD_BREACHED: "PASSWORD_BREACHED",
  TOKEN_ALREADY_USED: "TOKEN_ALREADY_USED",
  REFRESH_TOKEN_ROTATED: "REFRESH_TOKEN_ROTATED",
  REGISTRATION_DISABLED: "REGISTRATION_DISABLED",
  OAUTH_PROVIDER_UNAVAILABLE: "OAUTH_PROVIDER_UNAVAILABLE",
  OAUTH_STATE_INVALID: "OAUTH_STATE_INVALID",
  OAUTH_FAILED: "OAUTH_FAILED",
  OAUTH_ACCOUNT_LINK_REQUIRED: "OAUTH_ACCOUNT_LINK_REQUIRED",
  OAUTH_IDENTITY_IN_USE: "OAUTH_IDENTITY_IN_USE",
  LAST_LOGIN_METHOD: "LAST_LOGIN_METHOD",
  REDIRECT_NOT_ALLOWED: "REDIRECT_NOT_ALLOWED",
  CSRF_FAILED: "CSRF_FAILED",
  ORIGIN_NOT_ALLOWED: "ORIGIN_NOT_ALLOWED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  IDEMPOTENCY_IN_PROGRESS: "IDEMPOTENCY_IN_PROGRESS",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  BUSINESS_RULE: "BUSINESS_RULE",
  ENROLLMENT_CLOSED: "ENROLLMENT_CLOSED",
  ENROLLMENT_FULL: "ENROLLMENT_FULL",
  PREREQUISITES_NOT_MET: "PREREQUISITES_NOT_MET",
  ALREADY_ENROLLED: "ALREADY_ENROLLED",
  NOT_ENROLLED: "NOT_ENROLLED",
  ASSESSMENT_NOT_AVAILABLE: "ASSESSMENT_NOT_AVAILABLE",
  ATTEMPTS_EXHAUSTED: "ATTEMPTS_EXHAUSTED",
  ATTEMPT_CLOSED: "ATTEMPT_CLOSED",
  FILE_REJECTED: "FILE_REJECTED",
  WEBHOOK_SIGNATURE_INVALID: "WEBHOOK_SIGNATURE_INVALID",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AppErrorOptions {
  details?: unknown;
  headers?: Record<string, string>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly headers: Record<string, string>;

  constructor(statusCode: number, code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers ?? {};
  }
}

export const badRequest = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(400, code, message, { details });

export const unauthorized = (code: ErrorCode = ErrorCode.UNAUTHENTICATED, message = "Authentication required") =>
  new AppError(401, code, message);

export const forbidden = (message = "You do not have permission to perform this action", code: ErrorCode = ErrorCode.FORBIDDEN) =>
  new AppError(403, code, message);

export const notFound = (resource = "Resource") => new AppError(404, ErrorCode.NOT_FOUND, `${resource} not found`);

export const conflict = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(409, code, message, { details });

export const unprocessable = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(422, code, message, { details });

export const tooManyRequests = (retryAfterSeconds: number) =>
  new AppError(429, ErrorCode.RATE_LIMITED, "Too many requests, try again later", {
    headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    details: { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) },
  });

export const serviceUnavailable = (message = "Service temporarily unavailable") =>
  new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, message);
