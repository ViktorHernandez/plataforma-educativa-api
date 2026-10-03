CREATE TYPE "FileScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'FAILED', 'SKIPPED', 'NOT_REQUIRED');

CREATE TYPE "PrivacyRequestType" AS ENUM ('EXPORT', 'DELETION');

CREATE TYPE "PrivacyRequestStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

CREATE TYPE "KeyRotationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

ALTER TYPE "FilePurpose" ADD VALUE 'DATA_EXPORT';

ALTER TABLE "assessment_attempts" ADD COLUMN "extraTimeSeconds" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "audit_logs" ADD COLUMN "legalHold" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "files" ADD COLUMN "expiresAt" TIMESTAMPTZ(3),
ADD COLUMN "quarantineKey" VARCHAR(600),
ADD COLUMN "scanEngine" VARCHAR(60),
ADD COLUMN "scanSignature" VARCHAR(200),
ADD COLUMN "scanStatus" "FileScanStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "scannedAt" TIMESTAMPTZ(3);

ALTER TABLE "integration_connections" ADD COLUMN "externalCalendarId" VARCHAR(255),
ADD COLUMN "lastSyncedAt" TIMESTAMPTZ(3),
ADD COLUMN "syncEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "push_subscriptions" ADD COLUMN "authSecret" VARCHAR(255),
ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastFailureAt" TIMESTAMPTZ(3),
ADD COLUMN "p256dh" VARCHAR(255);

ALTER TABLE "report_exports" ADD COLUMN "expiresAt" TIMESTAMPTZ(3),
ADD COLUMN "rowCount" INTEGER;

ALTER TABLE "users" ADD COLUMN "anonymizedAt" TIMESTAMPTZ(3);

CREATE TABLE "assessment_accommodations" (
    "id" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "extraTimeSeconds" INTEGER NOT NULL,
    "reason" VARCHAR(500),
    "grantedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "assessment_accommodations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "calendar_event_links" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "sourceType" VARCHAR(40) NOT NULL,
    "sourceId" UUID NOT NULL,
    "externalEventId" VARCHAR(1024) NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "syncedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_event_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "privacy_requests" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "PrivacyRequestType" NOT NULL,
    "status" "PrivacyRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "fileId" UUID,
    "summary" JSONB,
    "error" VARCHAR(1000),
    "requestId" VARCHAR(64),

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "key_rotation_runs" (
    "id" UUID NOT NULL,
    "targetKeyId" VARCHAR(32) NOT NULL,
    "status" "KeyRotationStatus" NOT NULL DEFAULT 'RUNNING',
    "requestedById" UUID,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "lastError" VARCHAR(1000),
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "key_rotation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assessment_accommodations_userId_idx" ON "assessment_accommodations"("userId");

CREATE UNIQUE INDEX "assessment_accommodations_assessmentId_userId_key" ON "assessment_accommodations"("assessmentId", "userId");

CREATE UNIQUE INDEX "calendar_event_links_connectionId_sourceType_sourceId_key" ON "calendar_event_links"("connectionId", "sourceType", "sourceId");

CREATE INDEX "privacy_requests_userId_requestedAt_idx" ON "privacy_requests"("userId", "requestedAt");

CREATE INDEX "privacy_requests_type_status_scheduledFor_idx" ON "privacy_requests"("type", "status", "scheduledFor");

CREATE INDEX "key_rotation_runs_status_startedAt_idx" ON "key_rotation_runs"("status", "startedAt");

CREATE INDEX "activity_events_occurred_at_brin" ON "activity_events" USING BRIN ("occurredAt" timestamptz_minmax_ops);

CREATE INDEX "files_scanStatus_uploadedAt_idx" ON "files"("scanStatus", "uploadedAt");

CREATE INDEX "files_expiresAt_idx" ON "files"("expiresAt");

CREATE INDEX "integration_connections_status_syncEnabled_idx" ON "integration_connections"("status", "syncEnabled");

ALTER TABLE "assessment_accommodations" ADD CONSTRAINT "assessment_accommodations_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assessment_accommodations" ADD CONSTRAINT "assessment_accommodations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assessment_accommodations" ADD CONSTRAINT "assessment_accommodations_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "files" SET "scanStatus" = 'SKIPPED' WHERE "status" IN ('READY', 'REJECTED', 'DELETED');

UPDATE "files" SET "scanStatus" = 'NOT_REQUIRED' WHERE "purpose" = 'REPORT_EXPORT';

ALTER TABLE "assessment_accommodations" ADD CONSTRAINT "assessment_accommodations_extra_time_check" CHECK ("extraTimeSeconds" > 0 AND "extraTimeSeconds" <= 86400);

ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_extra_time_check" CHECK ("extraTimeSeconds" >= 0);

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_web_push_keys_check" CHECK ("provider" <> 'WEB_PUSH' OR ("p256dh" IS NOT NULL AND "authSecret" IS NOT NULL));

CREATE UNIQUE INDEX "privacy_requests_one_active_per_type" ON "privacy_requests" ("userId", "type") WHERE "status" IN ('PENDING', 'PROCESSING');

CREATE UNIQUE INDEX "key_rotation_runs_one_running" ON "key_rotation_runs" ("status") WHERE "status" = 'RUNNING';

CREATE INDEX "audit_logs_retention_idx" ON "audit_logs" ("occurredAt") WHERE "legalHold" = false;

DO $$
DECLARE
  exposed_role text;
  table_record record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    FOR table_record IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_record.tablename);
    END LOOP;
  END IF;
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = exposed_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', exposed_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', exposed_role);
    END IF;
  END LOOP;
END
$$;
