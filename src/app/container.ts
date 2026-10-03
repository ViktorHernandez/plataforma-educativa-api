import { PlatformSettingsService } from "../modules/admin/platform-settings.service.js";
import { AuthCookies } from "../modules/auth/auth-cookies.js";
import { AuthService } from "../modules/auth/auth.service.js";
import { createAuthenticator, type Authenticator } from "../modules/auth/authenticate.js";
import { LoginFlowService } from "../modules/auth/login-flow.service.js";
import { MfaService } from "../modules/auth/mfa.service.js";
import { buildOAuthRegistry, type OAuthProviderRegistry } from "../modules/auth/oauth/oauth-providers.js";
import { OAuthService } from "../modules/auth/oauth/oauth.service.js";
import { SecurityNotifier } from "../modules/auth/security-notifier.js";
import { SessionService } from "../modules/auth/session.service.js";
import { VerificationTokenService } from "../modules/auth/verification-token.service.js";
import { NotificationService } from "../modules/notifications/notification.service.js";
import { CatalogService } from "../modules/courses/catalog.service.js";
import { CourseAccessService } from "../modules/courses/course-access.service.js";
import { CourseStructureService } from "../modules/courses/course-structure.service.js";
import { CourseService } from "../modules/courses/course.service.js";
import { ProgramService } from "../modules/courses/program.service.js";
import { CertificateService } from "../modules/enrollments/certificate.service.js";
import { EnrollmentService } from "../modules/enrollments/enrollment.service.js";
import { ProgressService } from "../modules/enrollments/progress.service.js";
import { InstitutionService } from "../modules/institutions/institution.service.js";
import { UserService } from "../modules/users/user.service.js";
import { AssessmentService } from "../modules/assessments/assessment.service.js";
import { AttemptService } from "../modules/assessments/attempt.service.js";
import { QuestionBankService } from "../modules/assessments/question-bank.service.js";
import { AdminService } from "../modules/admin/admin.service.js";
import { FileService } from "../modules/files/file.service.js";
import { MessagingService } from "../modules/messaging/messaging.service.js";
import { AnnouncementService } from "../modules/notifications/announcement.service.js";
import { ReportService } from "../modules/reports/report.service.js";
import { WebhookService } from "../modules/webhooks/webhook.service.js";
import { AccommodationService } from "../modules/assessments/accommodation.service.js";
import { buildCalendarRegistry, type CalendarProviderRegistry } from "../modules/integrations/calendar-providers.js";
import { CalendarIntegrationService } from "../modules/integrations/calendar.service.js";
import { RetentionService } from "../modules/maintenance/retention.service.js";
import { PrivacyService } from "../modules/privacy/privacy.service.js";
import { KeyRotationService } from "../modules/security/key-rotation.service.js";
import type { Infrastructure } from "./infrastructure.js";

export interface Container extends Infrastructure {
  authenticator: Authenticator;
  authCookies: AuthCookies;
  settings: PlatformSettingsService;
  notifications: NotificationService;
  securityNotifier: SecurityNotifier;
  verificationTokens: VerificationTokenService;
  sessions: SessionService;
  loginFlow: LoginFlowService;
  mfa: MfaService;
  auth: AuthService;
  oauthRegistry: OAuthProviderRegistry;
  oauth: OAuthService;
  users: UserService;
  institutions: InstitutionService;
  courseAccess: CourseAccessService;
  courses: CourseService;
  structure: CourseStructureService;
  catalog: CatalogService;
  programs: ProgramService;
  enrollments: EnrollmentService;
  certificates: CertificateService;
  progress: ProgressService;
  questionBanks: QuestionBankService;
  assessments: AssessmentService;
  attempts: AttemptService;
  files: FileService;
  messaging: MessagingService;
  announcements: AnnouncementService;
  admin: AdminService;
  reports: ReportService;
  webhooks: WebhookService;
  accommodations: AccommodationService;
  privacy: PrivacyService;
  keyRotation: KeyRotationService;
  retention: RetentionService;
  calendar: CalendarIntegrationService;
}

export interface ContainerOptions {
  oauthRegistry?: OAuthProviderRegistry;
  calendarRegistry?: CalendarProviderRegistry;
  exportBatchSize?: number;
}

export function createContainer(infra: Infrastructure, options: ContainerOptions = {}): Container {
  const { config, db, redis, keys, logger } = infra;
  const settings = new PlatformSettingsService(db, redis, keys, logger, {
    "registration.enabled": true,
    "registration.allowedEmailDomains": [],
    "messaging.studentDirectMessages": true,
    "enrollment.requireInstitutionMembershipForPublicCourses": false,
  });
  const notifications = new NotificationService(db, infra.outbox);
  const securityNotifier = new SecurityNotifier(infra.emailQueue, notifications);
  const verificationTokens = new VerificationTokenService();
  const sessions = new SessionService(
    db,
    infra.accessTokens,
    infra.sessionStore,
    infra.realtime,
    { refreshTtlDays: config.REFRESH_TOKEN_TTL_DAYS, idleTimeoutDays: config.SESSION_IDLE_TIMEOUT_DAYS, reuseGraceSeconds: config.REFRESH_REUSE_GRACE_SECONDS },
    logger,
  );
  const loginFlow = new LoginFlowService(db, sessions, infra.audit, securityNotifier, infra.metrics);
  const mfa = new MfaService(db, infra.encryptor, config.SECRETS_PEPPER, config.JWT_ISSUER, infra.rateLimits, infra.audit, sessions, loginFlow, securityNotifier);
  const auth = new AuthService(
    db,
    config,
    infra.passwordHasher,
    infra.passwordPolicy,
    infra.breachChecker,
    infra.rateLimits,
    infra.audit,
    verificationTokens,
    sessions,
    loginFlow,
    infra.emailQueue,
    securityNotifier,
    settings,
    infra.metrics,
    (userId, code) => mfa.verifySecondFactor(userId, { code }),
  );
  const oauthRegistry = options.oauthRegistry ?? buildOAuthRegistry(config);
  const oauth = new OAuthService(
    db,
    redis,
    keys,
    oauthRegistry,
    config.PUBLIC_API_URL,
    config.OAUTH_REDIRECT_ALLOWLIST,
    infra.rateLimits,
    infra.audit,
    loginFlow,
    sessions,
    securityNotifier,
    settings,
    config.REGISTRATION_ENABLED,
    logger,
  );
  const users = new UserService(db, config, infra.authz, infra.audit, sessions, verificationTokens, infra.emailQueue, infra.rateLimits);
  const institutions = new InstitutionService(db, config, infra.authz, infra.audit, verificationTokens, infra.emailQueue);
  const courseAccess = new CourseAccessService(db, infra.authz);
  const courses = new CourseService(db, infra.authz, courseAccess, infra.audit);
  const structure = new CourseStructureService(db, courseAccess, infra.audit);
  const catalog = new CatalogService(db, infra.authz, courseAccess, infra.audit);
  const programs = new ProgramService(db, infra.authz, infra.audit);
  const enrollments = new EnrollmentService(db, courseAccess, infra.audit, notifications, settings);
  const certificates = new CertificateService(db, infra.authz, infra.audit, notifications);
  const progress = new ProgressService(db, courseAccess, certificates, notifications, infra.rateLimits);
  const questionBanks = new QuestionBankService(db, infra.authz, infra.audit);
  const assessments = new AssessmentService(db, courseAccess, infra.audit);
  const attempts = new AttemptService(db, courseAccess, assessments, progress, notifications, infra.outbox, infra.audit, infra.rateLimits);
  const files = new FileService(
    db,
    infra.storage,
    infra.authz,
    courseAccess,
    infra.audit,
    infra.rateLimits,
    config.FILE_URL_TTL_SECONDS,
    infra.scanner,
    infra.outbox,
    { maxScanBytes: config.ANTIVIRUS_MAX_SCAN_BYTES, scanRequired: config.FILE_SCAN_REQUIRED },
    logger,
  );
  const messaging = new MessagingService(db, redis, keys, infra.authz, courseAccess, users, settings, notifications, infra.realtime, infra.audit, infra.rateLimits);
  const announcements = new AnnouncementService(db, infra.authz, courseAccess, infra.outbox, infra.audit);
  const admin = new AdminService(db, infra.authz, infra.audit, sessions, securityNotifier);
  const reports = new ReportService(
    db,
    infra.authz,
    courseAccess,
    assessments,
    infra.outbox,
    infra.storage,
    infra.audit,
    infra.rateLimits,
    config.FILE_URL_TTL_SECONDS,
    config.REPORT_EXPORT_TTL_HOURS,
    options.exportBatchSize,
  );
  const webhooks = new WebhookService(db, infra.outbox, logger);
  const accommodations = new AccommodationService(db, assessments, infra.outbox, infra.audit);
  const privacy = new PrivacyService(
    db,
    config,
    infra.authz,
    infra.audit,
    infra.outbox,
    infra.storage,
    infra.emailQueue,
    notifications,
    infra.sessionStore,
    infra.realtime,
    infra.rateLimits,
    logger,
    config.FILE_URL_TTL_SECONDS,
    options.exportBatchSize,
  );
  const keyRotation = new KeyRotationService(db, infra.encryptor, infra.outbox, infra.audit, infra.authz, logger, config.KEY_ROTATION_BATCH_SIZE);
  const retention = new RetentionService(db, infra.storage, config, logger);
  const calendar = new CalendarIntegrationService(
    db,
    redis,
    keys,
    options.calendarRegistry ?? buildCalendarRegistry(config),
    infra.encryptor,
    infra.outbox,
    infra.audit,
    infra.rateLimits,
    config,
    logger,
  );

  return {
    ...infra,
    authenticator: createAuthenticator(infra.accessTokens, infra.sessionStore),
    authCookies: new AuthCookies(config),
    settings,
    notifications,
    securityNotifier,
    verificationTokens,
    sessions,
    loginFlow,
    mfa,
    auth,
    oauthRegistry,
    oauth,
    users,
    institutions,
    courseAccess,
    courses,
    structure,
    catalog,
    programs,
    enrollments,
    certificates,
    progress,
    questionBanks,
    assessments,
    attempts,
    files,
    messaging,
    announcements,
    admin,
    reports,
    webhooks,
    accommodations,
    privacy,
    keyRotation,
    retention,
    calendar,
  };
}
