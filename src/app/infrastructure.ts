import type { Redis } from "ioredis";
import type { AppConfig } from "../config/env.js";
import { ClamAvScanner } from "../core/antivirus/clamav-scanner.js";
import { DisabledMalwareScanner, type MalwareScanner } from "../core/antivirus/malware-scanner.js";
import { AuditService } from "../core/audit/audit-service.js";
import { AuthorizationService } from "../core/authz/authorization-service.js";
import { FieldEncryptor } from "../core/crypto/field-encryption.js";
import { createDatabase, type Database } from "../core/database/prisma.js";
import { OutboxService } from "../core/events/outbox.js";
import { IdempotencyService } from "../core/http/idempotency.js";
import { EmailQueue } from "../core/mail/email-queue.js";
import { ConsoleMailProvider, MemoryMailProvider, ResendMailProvider, type MailProvider } from "../core/mail/mail-provider.js";
import { createLogger, type Logger } from "../core/observability/logger.js";
import { Metrics } from "../core/observability/metrics.js";
import { DisabledPushProvider, FcmPushProvider, PushDispatcher, type PushProvider } from "../core/push/push-provider.js";
import { WebPushProvider } from "../core/push/web-push.js";
import { RealtimeBus } from "../core/realtime/realtime-bus.js";
import { createRedis, RedisKeys } from "../core/redis/redis.js";
import { AccessTokenService } from "../core/security/access-tokens.js";
import { DisabledBreachChecker, HibpBreachChecker, PasswordHasher, PasswordPolicy, type BreachChecker } from "../core/security/password.js";
import { RateLimitService, type RateLimitPolicy, type RateLimitPolicyName } from "../core/security/rate-limiter.js";
import { SessionStore } from "../core/security/session-store.js";
import { LocalStorageProvider } from "../core/storage/local-storage.js";
import { S3StorageProvider } from "../core/storage/s3-storage.js";
import type { StorageProvider } from "../core/storage/storage-provider.js";

export interface Infrastructure {
  config: AppConfig;
  logger: Logger;
  metrics: Metrics;
  db: Database;
  redis: Redis;
  keys: RedisKeys;
  encryptor: FieldEncryptor;
  passwordHasher: PasswordHasher;
  passwordPolicy: PasswordPolicy;
  breachChecker: BreachChecker;
  accessTokens: AccessTokenService;
  sessionStore: SessionStore;
  rateLimits: RateLimitService;
  authz: AuthorizationService;
  audit: AuditService;
  outbox: OutboxService;
  emailQueue: EmailQueue;
  realtime: RealtimeBus;
  idempotency: IdempotencyService;
  mail: MailProvider;
  push: PushDispatcher;
  storage: StorageProvider;
  scanner: MalwareScanner;
}

export interface InfrastructureOverrides {
  logger?: Logger;
  mail?: MailProvider;
  fcm?: PushProvider;
  webPush?: PushProvider;
  storage?: StorageProvider;
  scanner?: MalwareScanner;
  breachChecker?: BreachChecker;
  rateLimitOverrides?: Partial<Record<RateLimitPolicyName, RateLimitPolicy>>;
}

function createMailProvider(config: AppConfig, logger: Logger): MailProvider {
  switch (config.MAIL_PROVIDER) {
    case "resend":
      if (!config.RESEND_API_KEY) throw new Error("RESEND_API_KEY is required when MAIL_PROVIDER=resend");
      return new ResendMailProvider(config.RESEND_API_KEY, config.MAIL_FROM);
    case "memory":
      return new MemoryMailProvider();
    default:
      return new ConsoleMailProvider(logger);
  }
}

function createFcmProvider(config: AppConfig, logger: Logger): PushProvider {
  if (!config.PUSH_FCM_ENABLED || !config.FCM_PROJECT_ID || !config.FCM_CLIENT_EMAIL || !config.FCM_PRIVATE_KEY_BASE64) return new DisabledPushProvider();
  return new FcmPushProvider(
    {
      projectId: config.FCM_PROJECT_ID,
      clientEmail: config.FCM_CLIENT_EMAIL,
      privateKeyPem: Buffer.from(config.FCM_PRIVATE_KEY_BASE64, "base64").toString("utf8"),
    },
    logger,
  );
}

function createWebPushProvider(config: AppConfig, logger: Logger): PushProvider {
  if (!config.PUSH_WEB_ENABLED || !config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY || !config.VAPID_SUBJECT) return new DisabledPushProvider();
  return new WebPushProvider({ publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY, subject: config.VAPID_SUBJECT }, config.WEB_PUSH_ALLOWED_HOSTS, logger);
}

function createScanner(config: AppConfig): MalwareScanner {
  if (config.ANTIVIRUS_PROVIDER === "disabled") return new DisabledMalwareScanner();
  return new ClamAvScanner({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT, timeoutMs: config.CLAMAV_TIMEOUT_MS });
}

function createStorageProvider(config: AppConfig): StorageProvider {
  if (config.STORAGE_PROVIDER === "s3") {
    if (!config.S3_BUCKET || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY) {
      throw new Error("S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when STORAGE_PROVIDER=s3");
    }
    return new S3StorageProvider({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
  }
  return new LocalStorageProvider(config.STORAGE_LOCAL_DIR, config.PUBLIC_API_URL, config.SECRETS_PEPPER);
}

export function createInfrastructure(config: AppConfig, overrides: InfrastructureOverrides = {}): Infrastructure {
  const logger = overrides.logger ?? createLogger(config);
  const metrics = new Metrics("plataforma-educativa-api");
  const db = createDatabase(config, logger);
  const redis = createRedis({ url: config.REDIS_URL, protocol: config.REDIS_PROTOCOL, commandTimeoutMs: config.REDIS_COMMAND_TIMEOUT_MS }, logger);
  const keys = new RedisKeys(config.REDIS_KEY_PREFIX);
  const encryptor = new FieldEncryptor(config.encryptionKeys);
  const outbox = new OutboxService(encryptor);
  const rateLimits = new RateLimitService(redis, config.REDIS_KEY_PREFIX, logger, overrides.rateLimitOverrides);
  return {
    config,
    logger,
    metrics,
    db,
    redis,
    keys,
    encryptor,
    passwordHasher: new PasswordHasher({ memoryCostKib: config.ARGON2_MEMORY_KIB, timeCost: config.ARGON2_ITERATIONS, parallelism: 1 }),
    passwordPolicy: new PasswordPolicy(config.PASSWORD_MIN_LENGTH),
    breachChecker: overrides.breachChecker ?? (config.PASSWORD_BREACH_CHECK ? new HibpBreachChecker() : new DisabledBreachChecker()),
    accessTokens: new AccessTokenService(config.jwtKeys, config.JWT_ISSUER, config.JWT_AUDIENCE, config.ACCESS_TOKEN_TTL_SECONDS),
    sessionStore: new SessionStore(db, redis, keys, logger),
    rateLimits,
    authz: new AuthorizationService(db, redis, keys, logger),
    audit: new AuditService(db, logger),
    outbox,
    emailQueue: new EmailQueue(outbox),
    realtime: new RealtimeBus(redis, keys, logger),
    idempotency: new IdempotencyService(redis, keys, logger),
    mail: overrides.mail ?? createMailProvider(config, logger),
    push: new PushDispatcher({ FCM: overrides.fcm ?? createFcmProvider(config, logger), WEB_PUSH: overrides.webPush ?? createWebPushProvider(config, logger) }),
    storage: overrides.storage ?? createStorageProvider(config),
    scanner: overrides.scanner ?? createScanner(config),
  };
}

export async function closeInfrastructure(infra: Infrastructure): Promise<void> {
  await Promise.allSettled([infra.db.$disconnect(), infra.redis.quit()]);
}
