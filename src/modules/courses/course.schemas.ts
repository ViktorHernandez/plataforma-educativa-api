import { z } from "zod";
import { httpsUrl, isoDateTime, slug, trimmedString } from "../../core/http/schemas.js";
import {
  AccessModel,
  CohortStatus,
  ContentStatus,
  CourseKind,
  CourseLevel,
  CourseStatus,
  CourseVisibility,
  EnrollmentPolicy,
  LessonType,
  ProgramKind,
  ResourceKind,
} from "../../generated/prisma/enums.js";

const languageTag = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);

export const courseBody = z
  .object({
    slug,
    title: trimmedString(3, 200),
    kind: z.enum(CourseKind).optional(),
    subtitle: z.string().trim().max(300).nullable().optional(),
    summary: z.string().trim().max(1000).nullable().optional(),
    description: z.string().max(50_000).nullable().optional(),
    language: languageTag.optional(),
    level: z.enum(CourseLevel).optional(),
    visibility: z.enum(CourseVisibility).optional(),
    enrollmentPolicy: z.enum(EnrollmentPolicy).optional(),
    accessModel: z.enum(AccessModel).optional(),
    capacity: z.number().int().min(1).max(1_000_000).nullable().optional(),
    enrollmentOpensAt: isoDateTime.nullable().optional(),
    enrollmentClosesAt: isoDateTime.nullable().optional(),
    startsAt: isoDateTime.nullable().optional(),
    endsAt: isoDateTime.nullable().optional(),
    estimatedMinutes: z.number().int().min(1).max(100_000).nullable().optional(),
    certificateEnabled: z.boolean().optional(),
    completionThreshold: z.number().int().min(1).max(100).optional(),
    coverFileId: z.uuid().nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
  })
  .strict();

export const courseUpdateBody = courseBody.partial().strict();

export const courseSchema = z.object({
  id: z.uuid(),
  institutionId: z.uuid(),
  slug: z.string(),
  kind: z.enum(CourseKind),
  title: z.string(),
  subtitle: z.string().nullable(),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  language: z.string(),
  level: z.enum(CourseLevel),
  status: z.enum(CourseStatus),
  visibility: z.enum(CourseVisibility),
  enrollmentPolicy: z.enum(EnrollmentPolicy),
  accessModel: z.enum(AccessModel),
  capacity: z.number().int().nullable(),
  seatsTaken: z.number().int(),
  enrollmentOpensAt: isoDateTime.nullable(),
  enrollmentClosesAt: isoDateTime.nullable(),
  startsAt: isoDateTime.nullable(),
  endsAt: isoDateTime.nullable(),
  estimatedMinutes: z.number().int().nullable(),
  certificateEnabled: z.boolean(),
  completionThreshold: z.number().int(),
  coverFileId: z.uuid().nullable(),
  categoryId: z.uuid().nullable(),
  publishedAt: isoDateTime.nullable(),
  version: z.number().int(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const courseManageSchema = courseSchema.extend({ tags: z.array(z.string()), prerequisiteIds: z.array(z.uuid()) });

export const catalogItemSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  summary: z.string().nullable(),
  kind: z.enum(CourseKind),
  level: z.enum(CourseLevel),
  language: z.string(),
  accessModel: z.enum(AccessModel),
  enrollmentPolicy: z.enum(EnrollmentPolicy),
  enrollmentOpen: z.boolean(),
  seatsAvailable: z.number().int().nullable(),
  startsAt: isoDateTime.nullable(),
  endsAt: isoDateTime.nullable(),
  estimatedMinutes: z.number().int().nullable(),
  certificateEnabled: z.boolean(),
  coverFileId: z.uuid().nullable(),
  publishedAt: isoDateTime.nullable(),
  institution: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }),
  category: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }).nullable(),
  tags: z.array(z.string()),
});

export const catalogDetailSchema = catalogItemSchema.extend({
  description: z.string().nullable(),
  prerequisites: z.array(z.object({ id: z.uuid(), title: z.string(), slug: z.string() })),
  cohorts: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      status: z.enum(CohortStatus),
      startsAt: isoDateTime.nullable(),
      endsAt: isoDateTime.nullable(),
      seatsAvailable: z.number().int().nullable(),
    }),
  ),
  instructors: z.array(z.object({ id: z.uuid(), displayName: z.string(), headline: z.string().nullable(), avatarFileId: z.uuid().nullable() })),
  contentSummary: z.array(z.object({ type: z.enum(LessonType), count: z.number().int() })),
  viewerEnrollment: z.object({ id: z.uuid(), status: z.string(), progressPercent: z.number().int() }).nullable(),
});

export const catalogQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(24),
    q: z.string().trim().min(1).max(100).optional(),
    categoryId: z.uuid().optional(),
    institutionId: z.uuid().optional(),
    level: z.enum(CourseLevel).optional(),
    language: languageTag.optional(),
    accessModel: z.enum(AccessModel).optional(),
    tag: z.string().trim().max(60).optional(),
    sort: z.enum(["newest", "title", "startsAt"]).default("newest"),
  })
  .strict();

export const sectionBody = z
  .object({ title: trimmedString(1, 200), summary: z.string().trim().max(1000).nullable().optional(), position: z.number().int().min(1).optional() })
  .strict();

export const sectionSchema = z.object({ id: z.uuid(), title: z.string(), summary: z.string().nullable(), position: z.number().int() });

export const lessonBody = z
  .object({
    title: trimmedString(1, 200),
    type: z.enum(LessonType),
    status: z.enum(ContentStatus).optional(),
    isRequired: z.boolean().optional(),
    isPreview: z.boolean().optional(),
    estimatedMinutes: z.number().int().min(1).max(10_000).nullable().optional(),
    durationSeconds: z.number().int().min(1).max(86_400).nullable().optional(),
    body: z.string().max(200_000).nullable().optional(),
    contentUrl: httpsUrl.nullable().optional(),
    mediaFileId: z.uuid().nullable().optional(),
    assessmentId: z.uuid().nullable().optional(),
    position: z.number().int().min(1).optional(),
  })
  .strict();

export const lessonSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  type: z.enum(LessonType),
  status: z.enum(ContentStatus),
  position: z.number().int(),
  isRequired: z.boolean(),
  isPreview: z.boolean(),
  estimatedMinutes: z.number().int().nullable(),
  durationSeconds: z.number().int().nullable(),
  assessmentId: z.uuid().nullable(),
});

export const outlineSchema = z.object({
  courseId: z.uuid(),
  staffView: z.boolean(),
  modules: z.array(sectionSchema.extend({ units: z.array(sectionSchema.extend({ lessons: z.array(lessonSummarySchema) })) })),
});

export const lessonContentSchema = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  moduleId: z.uuid(),
  unitId: z.uuid(),
  title: z.string(),
  type: z.enum(LessonType),
  status: z.enum(ContentStatus),
  isRequired: z.boolean(),
  isPreview: z.boolean(),
  estimatedMinutes: z.number().int().nullable(),
  durationSeconds: z.number().int().nullable(),
  body: z.string().nullable(),
  contentUrl: z.string().nullable(),
  mediaFileId: z.uuid().nullable(),
  assessmentId: z.uuid().nullable(),
  staffView: z.boolean(),
  resources: z.array(
    z.object({ id: z.uuid(), kind: z.enum(ResourceKind), title: z.string(), description: z.string().nullable(), fileId: z.uuid().nullable(), url: z.string().nullable(), position: z.number().int() }),
  ),
  mediaTracks: z.array(z.object({ id: z.uuid(), kind: z.string(), language: z.string(), label: z.string(), isDefault: z.boolean(), trackFileId: z.uuid() })),
  progress: z.object({ status: z.string(), progressPercent: z.number().int(), positionSeconds: z.number().int().nullable(), completedAt: isoDateTime.nullable() }).nullable(),
});

export const resourceBody = z
  .object({
    kind: z.enum(ResourceKind),
    title: trimmedString(1, 200),
    description: z.string().trim().max(1000).nullable().optional(),
    fileId: z.uuid().nullable().optional(),
    url: httpsUrl.nullable().optional(),
  })
  .strict();

export const cohortBody = z
  .object({
    name: trimmedString(2, 120),
    status: z.enum(CohortStatus).optional(),
    startsAt: isoDateTime.nullable().optional(),
    endsAt: isoDateTime.nullable().optional(),
    enrollmentOpensAt: isoDateTime.nullable().optional(),
    enrollmentClosesAt: isoDateTime.nullable().optional(),
    capacity: z.number().int().min(1).max(1_000_000).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
  })
  .strict();

export const cohortSchema = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  name: z.string(),
  status: z.enum(CohortStatus),
  startsAt: isoDateTime.nullable(),
  endsAt: isoDateTime.nullable(),
  enrollmentOpensAt: isoDateTime.nullable(),
  enrollmentClosesAt: isoDateTime.nullable(),
  capacity: z.number().int().nullable(),
  seatsTaken: z.number().int(),
  timezone: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const programBody = z
  .object({
    slug,
    title: trimmedString(3, 200),
    kind: z.enum(ProgramKind).optional(),
    summary: z.string().trim().max(500).nullable().optional(),
    description: z.string().max(50_000).nullable().optional(),
    level: z.enum(CourseLevel).optional(),
    estimatedHours: z.number().int().min(1).max(100_000).nullable().optional(),
  })
  .strict();

export const programSchema = z.object({
  id: z.uuid(),
  institutionId: z.uuid(),
  slug: z.string(),
  kind: z.enum(ProgramKind),
  title: z.string(),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(ContentStatus),
  level: z.enum(CourseLevel),
  estimatedHours: z.number().int().nullable(),
  publishedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
