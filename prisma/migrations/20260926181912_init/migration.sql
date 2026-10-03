CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE "InstitutionType" AS ENUM ('PLATFORM', 'UNIVERSITY', 'SCHOOL', 'COMPANY', 'ACADEMY', 'OTHER');

CREATE TYPE "InstitutionStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

CREATE TYPE "ProgramKind" AS ENUM ('PROGRAM', 'LEARNING_PATH', 'SPECIALIZATION', 'DEGREE');

CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

CREATE TYPE "CourseKind" AS ENUM ('COURSE', 'SUBJECT', 'WORKSHOP');

CREATE TYPE "CourseLevel" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'ALL_LEVELS');

CREATE TYPE "CourseStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED');

CREATE TYPE "CourseVisibility" AS ENUM ('PUBLIC', 'INSTITUTION', 'UNLISTED', 'PRIVATE');

CREATE TYPE "EnrollmentPolicy" AS ENUM ('OPEN', 'APPROVAL', 'INVITE_ONLY', 'CLOSED');

CREATE TYPE "AccessModel" AS ENUM ('FREE', 'PAID');

CREATE TYPE "CohortStatus" AS ENUM ('PLANNED', 'OPEN', 'RUNNING', 'COMPLETED', 'CANCELLED');

CREATE TYPE "ClassGroupRole" AS ENUM ('STUDENT', 'TUTOR', 'TEACHER');

CREATE TYPE "LessonType" AS ENUM ('VIDEO', 'ARTICLE', 'DOCUMENT', 'ASSESSMENT', 'ASSIGNMENT', 'LIVE_SESSION', 'EXTERNAL_LINK', 'INTERACTIVE');

CREATE TYPE "ResourceKind" AS ENUM ('FILE', 'LINK');

CREATE TYPE "FilePurpose" AS ENUM ('AVATAR', 'COURSE_COVER', 'LESSON_MEDIA', 'LESSON_RESOURCE', 'CAPTION', 'MESSAGE_ATTACHMENT', 'REPORT_EXPORT', 'SUBMISSION');

CREATE TYPE "FileStatus" AS ENUM ('PENDING_UPLOAD', 'PROCESSING', 'READY', 'REJECTED', 'DELETED');

CREATE TYPE "FileVisibility" AS ENUM ('PRIVATE', 'INSTITUTION', 'PUBLIC');

CREATE TYPE "MediaTrackKind" AS ENUM ('CAPTIONS', 'SUBTITLES', 'DESCRIPTIONS', 'CHAPTERS', 'TRANSCRIPT');

CREATE TYPE "RoleScope" AS ENUM ('PLATFORM', 'INSTITUTION', 'COURSE');

CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');

CREATE TYPE "MemberType" AS ENUM ('STUDENT', 'TEACHER', 'STAFF', 'ADMIN');

CREATE TYPE "QuestionType" AS ENUM ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE', 'SHORT_ANSWER', 'NUMERIC', 'ESSAY', 'MATCHING', 'ORDERING');

CREATE TYPE "QuestionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

CREATE TYPE "QuestionDifficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

CREATE TYPE "AssessmentType" AS ENUM ('QUIZ', 'EXAM', 'PRACTICE', 'SURVEY');

CREATE TYPE "AssessmentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED');

CREATE TYPE "ScoringPolicy" AS ENUM ('HIGHEST', 'LATEST', 'AVERAGE', 'FIRST');

CREATE TYPE "RevealPolicy" AS ENUM ('NEVER', 'AFTER_SUBMISSION', 'AFTER_CLOSE');

CREATE TYPE "AssessmentItemKind" AS ENUM ('FIXED', 'POOL');

CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'PENDING_REVIEW', 'GRADED', 'VOIDED');

CREATE TYPE "GradingMode" AS ENUM ('AUTO', 'MANUAL');

CREATE TYPE "NotificationCategory" AS ENUM ('SECURITY', 'ACADEMIC', 'COMMUNICATION', 'ADMINISTRATIVE', 'SYSTEM');

CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'PUSH');

CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

CREATE TYPE "AnnouncementAudience" AS ENUM ('INSTITUTION', 'COURSE');

CREATE TYPE "ConversationType" AS ENUM ('DIRECT', 'GROUP', 'COURSE');

CREATE TYPE "ParticipantRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

CREATE TYPE "ClientPlatform" AS ENUM ('WEB', 'PWA', 'ANDROID', 'IOS', 'WINDOWS', 'MACOS', 'LINUX', 'OTHER');

CREATE TYPE "AuthMethod" AS ENUM ('PASSWORD', 'OAUTH');

CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE', 'MICROSOFT', 'GITHUB', 'APPLE');

CREATE TYPE "SessionRevocationReason" AS ENUM ('LOGOUT', 'USER_REVOKED', 'ADMIN_REVOKED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'REFRESH_REUSE', 'MFA_CHANGED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_DEACTIVATED', 'SECURITY');

CREATE TYPE "VerificationPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'ACCOUNT_SETUP', 'EMAIL_CHANGE');

CREATE TYPE "MfaFactorType" AS ENUM ('TOTP');

CREATE TYPE "MfaFactorStatus" AS ENUM ('PENDING', 'ACTIVE');

CREATE TYPE "ThemePreference" AS ENUM ('SYSTEM', 'LIGHT', 'DARK');

CREATE TYPE "IntegrationProvider" AS ENUM ('GOOGLE_CALENDAR', 'MICROSOFT_CALENDAR');

CREATE TYPE "IntegrationStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ERROR');

CREATE TYPE "PushProvider" AS ENUM ('FCM', 'WEB_PUSH');

CREATE TYPE "EnrollmentStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'REJECTED', 'SUSPENDED', 'EXPIRED');

CREATE TYPE "EnrollmentSource" AS ENUM ('SELF', 'ADMIN', 'PROGRAM', 'INVITATION', 'IMPORT');

CREATE TYPE "ProgressStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

CREATE TYPE "SectionType" AS ENUM ('MODULE', 'UNIT');

CREATE TYPE "CertificateStatus" AS ENUM ('ISSUED', 'REVOKED');

CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'INTEGRATION', 'ANONYMOUS');

CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

CREATE TYPE "AuditCategory" AS ENUM ('SECURITY', 'ACCESS', 'ACADEMIC', 'ADMINISTRATION', 'DATA');

CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

CREATE TYPE "ReportExportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "institutions" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" "InstitutionType" NOT NULL DEFAULT 'OTHER',
    "status" "InstitutionStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPlatform" BOOLEAN NOT NULL DEFAULT false,
    "defaultLocale" VARCHAR(20) NOT NULL DEFAULT 'es',
    "defaultTimezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "defaultCurrency" CHAR(3) NOT NULL DEFAULT 'USD',
    "customDomain" VARCHAR(253),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "branding" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "institutionId" UUID,
    "parentId" UUID,
    "slug" VARCHAR(80) NOT NULL,
    "names" JSONB NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "programs" (
    "id" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "kind" "ProgramKind" NOT NULL DEFAULT 'PROGRAM',
    "title" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(500),
    "description" TEXT,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "level" "CourseLevel" NOT NULL DEFAULT 'ALL_LEVELS',
    "estimatedHours" INTEGER,
    "createdById" UUID,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "program_courses" (
    "programId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "program_courses_pkey" PRIMARY KEY ("programId","courseId")
);

CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "kind" "CourseKind" NOT NULL DEFAULT 'COURSE',
    "title" VARCHAR(200) NOT NULL,
    "subtitle" VARCHAR(300),
    "summary" VARCHAR(1000),
    "description" TEXT,
    "language" VARCHAR(20) NOT NULL DEFAULT 'es',
    "level" "CourseLevel" NOT NULL DEFAULT 'ALL_LEVELS',
    "status" "CourseStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "CourseVisibility" NOT NULL DEFAULT 'PUBLIC',
    "enrollmentPolicy" "EnrollmentPolicy" NOT NULL DEFAULT 'OPEN',
    "accessModel" "AccessModel" NOT NULL DEFAULT 'FREE',
    "capacity" INTEGER,
    "seatsTaken" INTEGER NOT NULL DEFAULT 0,
    "enrollmentOpensAt" TIMESTAMPTZ(3),
    "enrollmentClosesAt" TIMESTAMPTZ(3),
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "estimatedMinutes" INTEGER,
    "certificateEnabled" BOOLEAN NOT NULL DEFAULT false,
    "completionThreshold" INTEGER NOT NULL DEFAULT 100,
    "coverFileId" UUID,
    "categoryId" UUID,
    "createdById" UUID,
    "publishedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "course_tags" (
    "courseId" UUID NOT NULL,
    "tagId" UUID NOT NULL,

    CONSTRAINT "course_tags_pkey" PRIMARY KEY ("courseId","tagId")
);

CREATE TABLE "course_prerequisites" (
    "courseId" UUID NOT NULL,
    "prerequisiteId" UUID NOT NULL,

    CONSTRAINT "course_prerequisites_pkey" PRIMARY KEY ("courseId","prerequisiteId")
);

CREATE TABLE "cohorts" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "CohortStatus" NOT NULL DEFAULT 'PLANNED',
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "enrollmentOpensAt" TIMESTAMPTZ(3),
    "enrollmentClosesAt" TIMESTAMPTZ(3),
    "capacity" INTEGER,
    "seatsTaken" INTEGER NOT NULL DEFAULT 0,
    "timezone" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cohorts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "class_groups" (
    "id" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "class_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "class_group_members" (
    "groupId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "ClassGroupRole" NOT NULL DEFAULT 'STUDENT',
    "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_group_members_pkey" PRIMARY KEY ("groupId","userId")
);

CREATE TABLE "course_modules" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "course_modules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "course_units" (
    "id" UUID NOT NULL,
    "moduleId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "course_units_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lessons" (
    "id" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "moduleId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "type" "LessonType" NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "isPreview" BOOLEAN NOT NULL DEFAULT false,
    "estimatedMinutes" INTEGER,
    "durationSeconds" INTEGER,
    "body" TEXT,
    "contentUrl" VARCHAR(2000),
    "mediaFileId" UUID,
    "assessmentId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lessons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lesson_resources" (
    "id" UUID NOT NULL,
    "lessonId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "ResourceKind" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000),
    "fileId" UUID,
    "url" VARCHAR(2000),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_resources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "ownerId" UUID,
    "institutionId" UUID,
    "purpose" "FilePurpose" NOT NULL,
    "status" "FileStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "visibility" "FileVisibility" NOT NULL DEFAULT 'PRIVATE',
    "storageProvider" VARCHAR(20) NOT NULL,
    "objectKey" VARCHAR(512) NOT NULL,
    "originalName" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(127) NOT NULL,
    "declaredSizeBytes" BIGINT NOT NULL,
    "sizeBytes" BIGINT,
    "checksumSha256" VARCHAR(64),
    "altText" VARCHAR(500),
    "rejectedReason" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedAt" TIMESTAMPTZ(3),
    "readyAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "media_tracks" (
    "id" UUID NOT NULL,
    "mediaFileId" UUID NOT NULL,
    "trackFileId" UUID NOT NULL,
    "kind" "MediaTrackKind" NOT NULL,
    "language" VARCHAR(20) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_tracks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "scope" "RoleScope" NOT NULL,
    "institutionId" UUID,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "role_permissions" (
    "roleId" UUID NOT NULL,
    "permission" VARCHAR(100) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permission")
);

CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "scopeType" "RoleScope" NOT NULL,
    "scopeKey" VARCHAR(80) NOT NULL,
    "institutionId" UUID,
    "courseId" UUID,
    "grantedById" UUID,
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "institution_memberships" (
    "id" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "memberType" "MemberType" NOT NULL DEFAULT 'STUDENT',
    "externalId" VARCHAR(80),
    "invitedById" UUID,
    "joinedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "institution_memberships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "question_banks" (
    "id" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "courseId" UUID,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "question_banks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "question_categories" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "categoryId" UUID,
    "type" "QuestionType" NOT NULL,
    "status" "QuestionStatus" NOT NULL DEFAULT 'DRAFT',
    "difficulty" "QuestionDifficulty",
    "prompt" TEXT NOT NULL,
    "explanation" TEXT,
    "points" DECIMAL(8,2) NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "question_options" (
    "id" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" VARCHAR(2000) NOT NULL,
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,
    "feedback" VARCHAR(1000),
    "matchTarget" VARCHAR(1000),

    CONSTRAINT "question_options_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assessments" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "instructions" TEXT,
    "type" "AssessmentType" NOT NULL DEFAULT 'QUIZ',
    "status" "AssessmentStatus" NOT NULL DEFAULT 'DRAFT',
    "opensAt" TIMESTAMPTZ(3),
    "closesAt" TIMESTAMPTZ(3),
    "timeLimitSeconds" INTEGER,
    "gracePeriodSeconds" INTEGER NOT NULL DEFAULT 30,
    "maxAttempts" INTEGER,
    "scoringPolicy" "ScoringPolicy" NOT NULL DEFAULT 'HIGHEST',
    "passingScorePercent" DECIMAL(5,2),
    "shuffleQuestions" BOOLEAN NOT NULL DEFAULT false,
    "shuffleOptions" BOOLEAN NOT NULL DEFAULT false,
    "feedbackPolicy" "RevealPolicy" NOT NULL DEFAULT 'AFTER_SUBMISSION',
    "revealAnswersPolicy" "RevealPolicy" NOT NULL DEFAULT 'AFTER_CLOSE',
    "weight" DECIMAL(6,2) NOT NULL DEFAULT 1,
    "createdById" UUID,
    "publishedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "assessments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assessment_items" (
    "id" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "AssessmentItemKind" NOT NULL,
    "questionId" UUID,
    "bankId" UUID,
    "categoryId" UUID,
    "difficulty" "QuestionDifficulty",
    "drawCount" INTEGER NOT NULL DEFAULT 1,
    "pointsOverride" DECIMAL(8,2),

    CONSTRAINT "assessment_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assessment_attempts" (
    "id" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "enrollmentId" UUID,
    "attemptNumber" INTEGER NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "seed" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMPTZ(3),
    "submittedAt" TIMESTAMPTZ(3),
    "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "gradedAt" TIMESTAMPTZ(3),
    "maxPoints" DECIMAL(10,2) NOT NULL,
    "scorePoints" DECIMAL(10,2),
    "scorePercent" DECIMAL(5,2),
    "passed" BOOLEAN,
    "ipAddress" VARCHAR(64),

    CONSTRAINT "assessment_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "attempt_questions" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "questionVersion" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "QuestionType" NOT NULL,
    "points" DECIMAL(8,2) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "answerKey" JSONB NOT NULL,

    CONSTRAINT "attempt_questions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "attempt_answers" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "attemptQuestionId" UUID NOT NULL,
    "response" JSONB NOT NULL,
    "savedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isCorrect" BOOLEAN,
    "awardedPoints" DECIMAL(8,2),
    "gradingMode" "GradingMode",
    "feedback" VARCHAR(4000),
    "gradedById" UUID,
    "gradedAt" TIMESTAMPTZ(3),

    CONSTRAINT "attempt_answers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assessment_results" (
    "id" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "enrollmentId" UUID,
    "attemptsCount" INTEGER NOT NULL DEFAULT 0,
    "scorePercent" DECIMAL(5,2),
    "passed" BOOLEAN,
    "lastAttemptId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assessment_results_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "institutionId" UUID,
    "readAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "provider" VARCHAR(40),
    "providerMessageId" VARCHAR(255),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(500),
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "courseId" UUID,
    "authorId" UUID,
    "audience" "AnnouncementAudience" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(20000) NOT NULL,
    "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "type" "ConversationType" NOT NULL,
    "institutionId" UUID,
    "courseId" UUID,
    "title" VARCHAR(160),
    "directKey" VARCHAR(80),
    "createdById" UUID,
    "lastMessageAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversation_participants" (
    "conversationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "ParticipantRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMPTZ(3),
    "lastReadAt" TIMESTAMPTZ(3),
    "mutedUntil" TIMESTAMPTZ(3),

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("conversationId","userId")
);

CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "senderId" UUID,
    "body" VARCHAR(8000) NOT NULL,
    "clientMessageId" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "message_attachments" (
    "messageId" UUID NOT NULL,
    "fileId" UUID NOT NULL,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("messageId","fileId")
);

CREATE TABLE "email_suppressions" (
    "email" VARCHAR(320) NOT NULL,
    "reason" VARCHAR(60) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("email")
);

CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "displayName" VARCHAR(120) NOT NULL,
    "passwordHash" TEXT,
    "passwordChangedAt" TIMESTAMPTZ(3),
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMPTZ(3),
    "suspendedAt" TIMESTAMPTZ(3),
    "suspendedReason" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_profiles" (
    "userId" UUID NOT NULL,
    "firstName" VARCHAR(80),
    "lastName" VARCHAR(80),
    "headline" VARCHAR(160),
    "bio" VARCHAR(2000),
    "pronouns" VARCHAR(40),
    "country" CHAR(2),
    "websiteUrl" VARCHAR(500),
    "organization" VARCHAR(160),
    "academicLevel" VARCHAR(80),
    "fieldOfStudy" VARCHAR(120),
    "avatarFileId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "user_preferences" (
    "userId" UUID NOT NULL,
    "locale" VARCHAR(20) NOT NULL DEFAULT 'es',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "theme" "ThemePreference" NOT NULL DEFAULT 'SYSTEM',
    "accessibility" JSONB NOT NULL DEFAULT '{}',
    "interface" JSONB NOT NULL DEFAULT '{}',
    "privacy" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceKeyHash" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120),
    "platform" "ClientPlatform" NOT NULL,
    "userAgent" VARCHAR(512),
    "lastIp" VARCHAR(64),
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID,
    "platform" "ClientPlatform" NOT NULL,
    "authMethod" "AuthMethod" NOT NULL,
    "authProvider" "OAuthProvider",
    "mfaVerified" BOOLEAN NOT NULL DEFAULT false,
    "ipAddress" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authenticatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" "SessionRevocationReason",

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "rotatedAt" TIMESTAMPTZ(3),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "verification_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" "VerificationPurpose" NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "login_challenges" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "context" JSONB NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mfa_factors" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "MfaFactorType" NOT NULL,
    "status" "MfaFactorStatus" NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "lastUsedStep" BIGINT,
    "label" VARCHAR(80),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMPTZ(3),

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "external_identities" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "providerSubject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(320),
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "displayName" VARCHAR(160),
    "linkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "externalAccountEmail" VARCHAR(320),
    "accessTokenCiphertext" TEXT NOT NULL,
    "refreshTokenCiphertext" TEXT,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMPTZ(3),
    "lastError" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID,
    "provider" "PushProvider" NOT NULL,
    "platform" "ClientPlatform" NOT NULL,
    "token" VARCHAR(2048) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "cohortId" UUID,
    "status" "EnrollmentStatus" NOT NULL,
    "source" "EnrollmentSource" NOT NULL DEFAULT 'SELF',
    "statusReason" VARCHAR(500),
    "holdsSeat" BOOLEAN NOT NULL DEFAULT false,
    "enrolledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "completedLessons" INTEGER NOT NULL DEFAULT 0,
    "requiredLessons" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMPTZ(3),
    "lastLessonId" UUID,
    "finalScorePercent" DECIMAL(5,2),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "enrollment_events" (
    "id" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "fromStatus" "EnrollmentStatus",
    "toStatus" "EnrollmentStatus" NOT NULL,
    "actorId" UUID,
    "reason" VARCHAR(500),
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "program_enrollments" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "programId" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL,
    "enrolledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "program_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lesson_progress" (
    "id" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "lessonId" UUID NOT NULL,
    "status" "ProgressStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "positionSeconds" INTEGER,
    "timeSpentSeconds" INTEGER NOT NULL DEFAULT 0,
    "firstViewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastViewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "lesson_progress_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "section_progress" (
    "id" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "sectionType" "SectionType" NOT NULL,
    "sectionId" UUID NOT NULL,
    "completedLessons" INTEGER NOT NULL DEFAULT 0,
    "requiredLessons" INTEGER NOT NULL DEFAULT 0,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "section_progress_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "activity_events" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "courseId" UUID,
    "lessonId" UUID,
    "enrollmentId" UUID,
    "verb" VARCHAR(60) NOT NULL,
    "data" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "certificates" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "courseId" UUID,
    "programId" UUID,
    "enrollmentId" UUID,
    "verificationCode" VARCHAR(32) NOT NULL,
    "status" "CertificateStatus" NOT NULL DEFAULT 'ISSUED',
    "snapshot" JSONB NOT NULL,
    "fileId" UUID,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" VARCHAR(500),

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" UUID,
    "actorType" "ActorType" NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "category" "AuditCategory" NOT NULL,
    "outcome" "AuditOutcome" NOT NULL,
    "resourceType" VARCHAR(60),
    "resourceId" VARCHAR(80),
    "institutionId" UUID,
    "ipAddress" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "requestId" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "aggregateType" VARCHAR(60),
    "aggregateId" VARCHAR(80),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "sensitivePayload" TEXT,
    "requestId" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMPTZ(3),
    "processedAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(1000),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inbound_webhook_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "externalId" VARCHAR(255) NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(1000),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "inbound_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "report_exports" (
    "id" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "institutionId" UUID,
    "type" VARCHAR(60) NOT NULL,
    "params" JSONB NOT NULL,
    "status" "ReportExportStatus" NOT NULL DEFAULT 'PENDING',
    "fileId" UUID,
    "error" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_settings" (
    "key" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "institutions_slug_key" ON "institutions"("slug");

CREATE UNIQUE INDEX "institutions_customDomain_key" ON "institutions"("customDomain");

CREATE INDEX "institutions_status_idx" ON "institutions"("status");

CREATE INDEX "categories_parentId_idx" ON "categories"("parentId");

CREATE UNIQUE INDEX "categories_institutionId_slug_key" ON "categories"("institutionId", "slug");

CREATE UNIQUE INDEX "tags_institutionId_slug_key" ON "tags"("institutionId", "slug");

CREATE INDEX "programs_status_publishedAt_idx" ON "programs"("status", "publishedAt");

CREATE UNIQUE INDEX "programs_institutionId_slug_key" ON "programs"("institutionId", "slug");

CREATE INDEX "program_courses_courseId_idx" ON "program_courses"("courseId");

CREATE INDEX "courses_status_visibility_publishedAt_idx" ON "courses"("status", "visibility", "publishedAt");

CREATE INDEX "courses_institutionId_status_idx" ON "courses"("institutionId", "status");

CREATE INDEX "courses_categoryId_idx" ON "courses"("categoryId");

CREATE UNIQUE INDEX "courses_institutionId_slug_key" ON "courses"("institutionId", "slug");

CREATE INDEX "course_tags_tagId_idx" ON "course_tags"("tagId");

CREATE INDEX "course_prerequisites_prerequisiteId_idx" ON "course_prerequisites"("prerequisiteId");

CREATE INDEX "cohorts_courseId_status_idx" ON "cohorts"("courseId", "status");

CREATE UNIQUE INDEX "class_groups_institutionId_code_key" ON "class_groups"("institutionId", "code");

CREATE INDEX "class_group_members_userId_idx" ON "class_group_members"("userId");

CREATE INDEX "course_modules_courseId_position_idx" ON "course_modules"("courseId", "position");

CREATE INDEX "course_units_moduleId_position_idx" ON "course_units"("moduleId", "position");

CREATE INDEX "course_units_courseId_idx" ON "course_units"("courseId");

CREATE UNIQUE INDEX "lessons_assessmentId_key" ON "lessons"("assessmentId");

CREATE INDEX "lessons_unitId_position_idx" ON "lessons"("unitId", "position");

CREATE INDEX "lessons_courseId_status_idx" ON "lessons"("courseId", "status");

CREATE INDEX "lesson_resources_lessonId_position_idx" ON "lesson_resources"("lessonId", "position");

CREATE UNIQUE INDEX "files_objectKey_key" ON "files"("objectKey");

CREATE INDEX "files_ownerId_createdAt_idx" ON "files"("ownerId", "createdAt");

CREATE INDEX "files_status_createdAt_idx" ON "files"("status", "createdAt");

CREATE UNIQUE INDEX "media_tracks_mediaFileId_kind_language_key" ON "media_tracks"("mediaFileId", "kind", "language");

CREATE UNIQUE INDEX "roles_institutionId_key_key" ON "roles"("institutionId", "key");

CREATE INDEX "role_assignments_userId_idx" ON "role_assignments"("userId");

CREATE INDEX "role_assignments_institutionId_idx" ON "role_assignments"("institutionId");

CREATE INDEX "role_assignments_courseId_idx" ON "role_assignments"("courseId");

CREATE INDEX "role_assignments_roleId_idx" ON "role_assignments"("roleId");

CREATE UNIQUE INDEX "role_assignments_userId_roleId_scopeKey_key" ON "role_assignments"("userId", "roleId", "scopeKey");

CREATE INDEX "institution_memberships_userId_status_idx" ON "institution_memberships"("userId", "status");

CREATE INDEX "institution_memberships_institutionId_status_memberType_idx" ON "institution_memberships"("institutionId", "status", "memberType");

CREATE UNIQUE INDEX "institution_memberships_institutionId_userId_key" ON "institution_memberships"("institutionId", "userId");

CREATE UNIQUE INDEX "institution_memberships_institutionId_externalId_key" ON "institution_memberships"("institutionId", "externalId");

CREATE INDEX "question_banks_institutionId_archivedAt_idx" ON "question_banks"("institutionId", "archivedAt");

CREATE INDEX "question_banks_courseId_idx" ON "question_banks"("courseId");

CREATE UNIQUE INDEX "question_categories_bankId_name_key" ON "question_categories"("bankId", "name");

CREATE INDEX "questions_bankId_status_idx" ON "questions"("bankId", "status");

CREATE INDEX "questions_categoryId_status_idx" ON "questions"("categoryId", "status");

CREATE INDEX "question_options_questionId_position_idx" ON "question_options"("questionId", "position");

CREATE INDEX "assessments_courseId_status_idx" ON "assessments"("courseId", "status");

CREATE INDEX "assessment_items_assessmentId_position_idx" ON "assessment_items"("assessmentId", "position");

CREATE INDEX "assessment_items_questionId_idx" ON "assessment_items"("questionId");

CREATE INDEX "assessment_attempts_userId_assessmentId_idx" ON "assessment_attempts"("userId", "assessmentId");

CREATE INDEX "assessment_attempts_assessmentId_status_idx" ON "assessment_attempts"("assessmentId", "status");

CREATE INDEX "assessment_attempts_status_deadlineAt_idx" ON "assessment_attempts"("status", "deadlineAt");

CREATE UNIQUE INDEX "assessment_attempts_assessmentId_userId_attemptNumber_key" ON "assessment_attempts"("assessmentId", "userId", "attemptNumber");

CREATE INDEX "attempt_questions_questionId_idx" ON "attempt_questions"("questionId");

CREATE UNIQUE INDEX "attempt_questions_attemptId_position_key" ON "attempt_questions"("attemptId", "position");

CREATE UNIQUE INDEX "attempt_answers_attemptQuestionId_key" ON "attempt_answers"("attemptQuestionId");

CREATE INDEX "attempt_answers_attemptId_idx" ON "attempt_answers"("attemptId");

CREATE INDEX "assessment_results_userId_idx" ON "assessment_results"("userId");

CREATE UNIQUE INDEX "assessment_results_assessmentId_userId_key" ON "assessment_results"("assessmentId", "userId");

CREATE INDEX "notifications_userId_archivedAt_id_idx" ON "notifications"("userId", "archivedAt", "id" DESC);

CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

CREATE UNIQUE INDEX "notification_deliveries_notificationId_channel_key" ON "notification_deliveries"("notificationId", "channel");

CREATE INDEX "announcements_courseId_publishedAt_idx" ON "announcements"("courseId", "publishedAt");

CREATE INDEX "announcements_institutionId_publishedAt_idx" ON "announcements"("institutionId", "publishedAt");

CREATE UNIQUE INDEX "conversations_directKey_key" ON "conversations"("directKey");

CREATE INDEX "conversations_courseId_idx" ON "conversations"("courseId");

CREATE INDEX "conversation_participants_userId_leftAt_idx" ON "conversation_participants"("userId", "leftAt");

CREATE INDEX "messages_conversationId_id_idx" ON "messages"("conversationId", "id" DESC);

CREATE UNIQUE INDEX "messages_conversationId_senderId_clientMessageId_key" ON "messages"("conversationId", "senderId", "clientMessageId");

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE INDEX "users_status_createdAt_idx" ON "users"("status", "createdAt");

CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

CREATE UNIQUE INDEX "user_profiles_avatarFileId_key" ON "user_profiles"("avatarFileId");

CREATE UNIQUE INDEX "notification_preferences_userId_category_channel_key" ON "notification_preferences"("userId", "category", "channel");

CREATE UNIQUE INDEX "user_devices_userId_deviceKeyHash_key" ON "user_devices"("userId", "deviceKeyHash");

CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

CREATE INDEX "refresh_tokens_sessionId_idx" ON "refresh_tokens"("sessionId");

CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

CREATE UNIQUE INDEX "verification_tokens_tokenHash_key" ON "verification_tokens"("tokenHash");

CREATE INDEX "verification_tokens_userId_purpose_idx" ON "verification_tokens"("userId", "purpose");

CREATE INDEX "verification_tokens_expiresAt_idx" ON "verification_tokens"("expiresAt");

CREATE UNIQUE INDEX "login_challenges_tokenHash_key" ON "login_challenges"("tokenHash");

CREATE INDEX "login_challenges_userId_idx" ON "login_challenges"("userId");

CREATE INDEX "login_challenges_expiresAt_idx" ON "login_challenges"("expiresAt");

CREATE UNIQUE INDEX "mfa_factors_userId_type_key" ON "mfa_factors"("userId", "type");

CREATE UNIQUE INDEX "recovery_codes_userId_codeHash_key" ON "recovery_codes"("userId", "codeHash");

CREATE UNIQUE INDEX "external_identities_provider_providerSubject_key" ON "external_identities"("provider", "providerSubject");

CREATE UNIQUE INDEX "external_identities_userId_provider_key" ON "external_identities"("userId", "provider");

CREATE UNIQUE INDEX "integration_connections_userId_provider_key" ON "integration_connections"("userId", "provider");

CREATE UNIQUE INDEX "push_subscriptions_token_key" ON "push_subscriptions"("token");

CREATE INDEX "push_subscriptions_userId_revokedAt_idx" ON "push_subscriptions"("userId", "revokedAt");

CREATE INDEX "enrollments_courseId_status_idx" ON "enrollments"("courseId", "status");

CREATE INDEX "enrollments_userId_status_lastActivityAt_idx" ON "enrollments"("userId", "status", "lastActivityAt");

CREATE INDEX "enrollments_institutionId_status_idx" ON "enrollments"("institutionId", "status");

CREATE INDEX "enrollments_cohortId_idx" ON "enrollments"("cohortId");

CREATE UNIQUE INDEX "enrollments_userId_courseId_key" ON "enrollments"("userId", "courseId");

CREATE INDEX "enrollment_events_enrollmentId_occurredAt_idx" ON "enrollment_events"("enrollmentId", "occurredAt");

CREATE INDEX "program_enrollments_programId_status_idx" ON "program_enrollments"("programId", "status");

CREATE UNIQUE INDEX "program_enrollments_userId_programId_key" ON "program_enrollments"("userId", "programId");

CREATE INDEX "lesson_progress_userId_lastViewedAt_idx" ON "lesson_progress"("userId", "lastViewedAt");

CREATE INDEX "lesson_progress_lessonId_status_idx" ON "lesson_progress"("lessonId", "status");

CREATE UNIQUE INDEX "lesson_progress_enrollmentId_lessonId_key" ON "lesson_progress"("enrollmentId", "lessonId");

CREATE UNIQUE INDEX "section_progress_enrollmentId_sectionType_sectionId_key" ON "section_progress"("enrollmentId", "sectionType", "sectionId");

CREATE INDEX "activity_events_userId_occurredAt_idx" ON "activity_events"("userId", "occurredAt");

CREATE INDEX "activity_events_courseId_occurredAt_idx" ON "activity_events"("courseId", "occurredAt");

CREATE UNIQUE INDEX "certificates_enrollmentId_key" ON "certificates"("enrollmentId");

CREATE UNIQUE INDEX "certificates_verificationCode_key" ON "certificates"("verificationCode");

CREATE INDEX "certificates_userId_issuedAt_idx" ON "certificates"("userId", "issuedAt");

CREATE INDEX "audit_logs_actorId_occurredAt_idx" ON "audit_logs"("actorId", "occurredAt");

CREATE INDEX "audit_logs_institutionId_occurredAt_idx" ON "audit_logs"("institutionId", "occurredAt");

CREATE INDEX "audit_logs_action_occurredAt_idx" ON "audit_logs"("action", "occurredAt");

CREATE INDEX "audit_logs_resourceType_resourceId_idx" ON "audit_logs"("resourceType", "resourceId");

CREATE INDEX "audit_logs_occurredAt_idx" ON "audit_logs"("occurredAt");

CREATE INDEX "outbox_events_processedAt_createdAt_idx" ON "outbox_events"("processedAt", "createdAt");

CREATE INDEX "inbound_webhook_events_status_receivedAt_idx" ON "inbound_webhook_events"("status", "receivedAt");

CREATE UNIQUE INDEX "inbound_webhook_events_provider_externalId_key" ON "inbound_webhook_events"("provider", "externalId");

CREATE INDEX "report_exports_requestedById_createdAt_idx" ON "report_exports"("requestedById", "createdAt");

ALTER TABLE "categories" ADD CONSTRAINT "categories_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tags" ADD CONSTRAINT "tags_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "programs" ADD CONSTRAINT "programs_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "programs" ADD CONSTRAINT "programs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "program_courses" ADD CONSTRAINT "program_courses_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "program_courses" ADD CONSTRAINT "program_courses_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "courses" ADD CONSTRAINT "courses_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "courses" ADD CONSTRAINT "courses_coverFileId_fkey" FOREIGN KEY ("coverFileId") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "courses" ADD CONSTRAINT "courses_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "courses" ADD CONSTRAINT "courses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "course_tags" ADD CONSTRAINT "course_tags_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "course_tags" ADD CONSTRAINT "course_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "course_prerequisites" ADD CONSTRAINT "course_prerequisites_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "course_prerequisites" ADD CONSTRAINT "course_prerequisites_prerequisiteId_fkey" FOREIGN KEY ("prerequisiteId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "class_groups" ADD CONSTRAINT "class_groups_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "class_group_members" ADD CONSTRAINT "class_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "class_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "class_group_members" ADD CONSTRAINT "class_group_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "course_units" ADD CONSTRAINT "course_units_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "course_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "course_units" ADD CONSTRAINT "course_units_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lessons" ADD CONSTRAINT "lessons_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "course_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lessons" ADD CONSTRAINT "lessons_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "course_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lessons" ADD CONSTRAINT "lessons_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lessons" ADD CONSTRAINT "lessons_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "lessons" ADD CONSTRAINT "lessons_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "lesson_resources" ADD CONSTRAINT "lesson_resources_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lesson_resources" ADD CONSTRAINT "lesson_resources_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "files" ADD CONSTRAINT "files_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "files" ADD CONSTRAINT "files_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "media_tracks" ADD CONSTRAINT "media_tracks_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "media_tracks" ADD CONSTRAINT "media_tracks_trackFileId_fkey" FOREIGN KEY ("trackFileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "roles" ADD CONSTRAINT "roles_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "institution_memberships" ADD CONSTRAINT "institution_memberships_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "institution_memberships" ADD CONSTRAINT "institution_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "institution_memberships" ADD CONSTRAINT "institution_memberships_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "question_banks" ADD CONSTRAINT "question_banks_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "question_banks" ADD CONSTRAINT "question_banks_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "question_banks" ADD CONSTRAINT "question_banks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "question_categories" ADD CONSTRAINT "question_categories_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "question_banks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "questions" ADD CONSTRAINT "questions_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "question_banks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "questions" ADD CONSTRAINT "questions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "question_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "questions" ADD CONSTRAINT "questions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "question_options" ADD CONSTRAINT "question_options_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assessments" ADD CONSTRAINT "assessments_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assessments" ADD CONSTRAINT "assessments_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assessments" ADD CONSTRAINT "assessments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "question_banks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "question_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "assessment_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "assessment_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_attemptQuestionId_fkey" FOREIGN KEY ("attemptQuestionId") REFERENCES "attempt_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_gradedById_fkey" FOREIGN KEY ("gradedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "assessment_results" ADD CONSTRAINT "assessment_results_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assessment_results" ADD CONSTRAINT "assessment_results_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assessment_results" ADD CONSTRAINT "assessment_results_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "messages" ADD CONSTRAINT "messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_avatarFileId_fkey" FOREIGN KEY ("avatarFileId") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "user_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "user_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "cohorts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "enrollment_events" ADD CONSTRAINT "enrollment_events_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "enrollment_events" ADD CONSTRAINT "enrollment_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "section_progress" ADD CONSTRAINT "section_progress_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "roles_system_key_key" ON "roles" ("key") WHERE "institutionId" IS NULL;

CREATE UNIQUE INDEX "categories_global_slug_key" ON "categories" ("slug") WHERE "institutionId" IS NULL;

CREATE UNIQUE INDEX "assessment_attempts_single_open_key" ON "assessment_attempts" ("assessmentId", "userId") WHERE "status" = 'IN_PROGRESS';

CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" ("availableAt") WHERE "processedAt" IS NULL AND "failedAt" IS NULL;

CREATE INDEX "courses_title_trgm_idx" ON "courses" USING gin ("title" gin_trgm_ops) WHERE "deletedAt" IS NULL;

CREATE INDEX "users_email_trgm_idx" ON "users" USING gin ("email" gin_trgm_ops);

CREATE INDEX "users_display_name_trgm_idx" ON "users" USING gin ("displayName" gin_trgm_ops);

ALTER TABLE "courses" ADD CONSTRAINT "courses_capacity_check" CHECK ("capacity" IS NULL OR "capacity" >= 0);

ALTER TABLE "courses" ADD CONSTRAINT "courses_seats_check" CHECK ("seatsTaken" >= 0 AND ("capacity" IS NULL OR "seatsTaken" <= "capacity"));

ALTER TABLE "courses" ADD CONSTRAINT "courses_completion_threshold_check" CHECK ("completionThreshold" BETWEEN 1 AND 100);

ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_seats_check" CHECK ("seatsTaken" >= 0 AND ("capacity" IS NULL OR ("capacity" >= 0 AND "seatsTaken" <= "capacity")));

ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_progress_check" CHECK ("progressPercent" BETWEEN 0 AND 100 AND "completedLessons" >= 0 AND "requiredLessons" >= 0);

ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_values_check" CHECK ("progressPercent" BETWEEN 0 AND 100 AND "timeSpentSeconds" >= 0 AND ("positionSeconds" IS NULL OR "positionSeconds" >= 0));

ALTER TABLE "section_progress" ADD CONSTRAINT "section_progress_values_check" CHECK ("progressPercent" BETWEEN 0 AND 100);

ALTER TABLE "assessments" ADD CONSTRAINT "assessments_window_check" CHECK ("opensAt" IS NULL OR "closesAt" IS NULL OR "opensAt" < "closesAt");

ALTER TABLE "assessments" ADD CONSTRAINT "assessments_limits_check" CHECK (("maxAttempts" IS NULL OR "maxAttempts" > 0) AND ("timeLimitSeconds" IS NULL OR "timeLimitSeconds" > 0) AND "gracePeriodSeconds" >= 0 AND ("passingScorePercent" IS NULL OR "passingScorePercent" BETWEEN 0 AND 100) AND "weight" >= 0);

ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_kind_check" CHECK (("kind" = 'FIXED' AND "questionId" IS NOT NULL) OR ("kind" = 'POOL' AND "bankId" IS NOT NULL AND "drawCount" > 0));

ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_scope_check" CHECK (("scopeType" = 'PLATFORM' AND "institutionId" IS NULL AND "courseId" IS NULL) OR ("scopeType" = 'INSTITUTION' AND "institutionId" IS NOT NULL AND "courseId" IS NULL) OR ("scopeType" = 'COURSE' AND "institutionId" IS NOT NULL AND "courseId" IS NOT NULL));

ALTER TABLE "questions" ADD CONSTRAINT "questions_points_check" CHECK ("points" >= 0);

DO $$
DECLARE
  exposed_role text;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = exposed_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', exposed_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', exposed_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', exposed_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', exposed_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', exposed_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', exposed_role);
    END IF;
  END LOOP;
END
$$;
