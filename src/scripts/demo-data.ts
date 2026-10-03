import type { Container } from "../app/container.js";
import type { AppConfig } from "../config/env.js";
import { scopeKeyFor } from "../core/authz/authorization-service.js";
import { SystemRole } from "../core/authz/permissions.js";
import { databaseTargetId, isLocalDatabaseHost, supabaseProjectRef } from "../core/database/connection.js";
import type { Database } from "../core/database/prisma.js";
import type { RequestMeta } from "../core/http/request-context.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  AssessmentStatus,
  AttemptStatus,
  ContentStatus,
  CourseLevel,
  CourseStatus,
  CourseVisibility,
  EnrollmentPolicy,
  EnrollmentStatus,
  InstitutionType,
  LessonType,
  MemberType,
  MembershipStatus,
  QuestionType,
  RoleScope,
  UserStatus,
} from "../generated/prisma/enums.js";
import type { AnswerKey } from "../modules/assessments/grading.js";
import { ensurePlatformInstitution, syncSystemRoles } from "../modules/access/system-bootstrap.js";

export const DEMO_EMAIL_DOMAIN = "demo.plataforma.test";
export const DEMO_INSTITUTION_SLUG = "demo-instituto";
export const DEMO_EXTERNAL_INSTITUTION_SLUG = "demo-colegio";
const LOCAL_DEFAULT_PASSWORD = "Demo-Local-Solo-2026!";
const seedMeta: RequestMeta = { ip: null, userAgent: "demo-seed", requestId: null };

export const demoAccounts = {
  platformAdmin: { email: `plataforma.admin@${DEMO_EMAIL_DOMAIN}`, displayName: "Demo · Administración de plataforma" },
  institutionAdmin: { email: `institucion.admin@${DEMO_EMAIL_DOMAIN}`, displayName: "Demo · Administración institucional" },
  teacher: { email: `docente@${DEMO_EMAIL_DOMAIN}`, displayName: "Demo · Docente" },
  student: { email: `estudiante@${DEMO_EMAIL_DOMAIN}`, displayName: "Demo · Estudiante" },
  secondStudent: { email: `estudiante2@${DEMO_EMAIL_DOMAIN}`, displayName: "Demo · Segunda estudiante" },
  externalAdmin: { email: `externo.admin@${DEMO_EMAIL_DOMAIN}`, displayName: "Demo · Admin de otra institución" },
} as const;

export type DemoAccountKey = keyof typeof demoAccounts;

export interface DemoTarget {
  targetId: string;
  host: string;
  local: boolean;
  password: string;
  allowExistingData: boolean;
}

export interface DemoRegistry {
  targetId: string;
  institutionIds: string[];
  userIds: string[];
}

export class DemoEnvironmentError extends Error {}

const REGISTRY_KEY = "demo.dataset.registry";
const MIN_DEMO_PASSWORD_LENGTH = 12;

export function resolveDemoTarget(
  config: Pick<AppConfig, "APP_ENV" | "NODE_ENV" | "DATABASE_URL" | "DIRECT_DATABASE_URL" | "isProduction">,
  env: NodeJS.ProcessEnv = process.env,
): DemoTarget {
  if (config.isProduction || config.NODE_ENV === "production" || (config.APP_ENV !== "development" && config.APP_ENV !== "test")) {
    throw new DemoEnvironmentError("Demo data can only be created when APP_ENV is development or test");
  }
  const targetId = databaseTargetId(config.DATABASE_URL);
  if (!targetId) throw new DemoEnvironmentError("DATABASE_URL is not a valid connection URL");
  if (config.DIRECT_DATABASE_URL && databaseTargetId(config.DIRECT_DATABASE_URL) !== targetId && supabaseProjectRef(config.DATABASE_URL) !== null) {
    throw new DemoEnvironmentError("DATABASE_URL and DIRECT_DATABASE_URL point to different databases");
  }
  const host = new URL(config.DATABASE_URL).hostname.toLowerCase();
  const local = isLocalDatabaseHost(host);
  if (!local && env["DEMO_ALLOW_DATABASE_TARGET"]?.trim().toLowerCase() !== targetId) {
    const kind = supabaseProjectRef(config.DATABASE_URL) ? "a Supabase project" : "a remote database";
    throw new DemoEnvironmentError(`DATABASE_URL points to ${kind} (${targetId}). Demo data is only written there when DEMO_ALLOW_DATABASE_TARGET=${targetId} is set explicitly.`);
  }
  const configuredPassword = env["DEMO_PASSWORD"]?.trim() ?? "";
  if (!local && configuredPassword.length === 0) {
    throw new DemoEnvironmentError("DEMO_PASSWORD is required when the demo database is not local");
  }
  if (configuredPassword.length > 0 && configuredPassword.length < MIN_DEMO_PASSWORD_LENGTH) {
    throw new DemoEnvironmentError(`DEMO_PASSWORD must have at least ${MIN_DEMO_PASSWORD_LENGTH} characters`);
  }
  const password = configuredPassword.length > 0 ? configuredPassword : LOCAL_DEFAULT_PASSWORD;
  return { targetId, host, local, password, allowExistingData: env["DEMO_ALLOW_EXISTING_DATA"]?.trim() === "true" };
}

export async function readDemoRegistry(db: Database): Promise<DemoRegistry | null> {
  const row = await db.platformSetting.findUnique({ where: { key: REGISTRY_KEY } });
  if (!row) return null;
  const value = row.value as Partial<DemoRegistry>;
  return {
    targetId: typeof value.targetId === "string" ? value.targetId : "",
    institutionIds: Array.isArray(value.institutionIds) ? value.institutionIds.filter((id): id is string => typeof id === "string") : [],
    userIds: Array.isArray(value.userIds) ? value.userIds.filter((id): id is string => typeof id === "string") : [],
  };
}

async function writeDemoRegistry(db: Database, registry: DemoRegistry): Promise<void> {
  const value = { targetId: registry.targetId, institutionIds: [...new Set(registry.institutionIds)], userIds: [...new Set(registry.userIds)] };
  await db.platformSetting.upsert({ where: { key: REGISTRY_KEY }, create: { key: REGISTRY_KEY, value }, update: { value } });
}

export async function registerDemoRecords(db: Database, target: DemoTarget, records: { institutionIds?: string[]; userIds?: string[] }): Promise<void> {
  const registry = (await readDemoRegistry(db)) ?? { targetId: target.targetId, institutionIds: [], userIds: [] };
  registry.institutionIds.push(...(records.institutionIds ?? []));
  registry.userIds.push(...(records.userIds ?? []));
  await writeDemoRegistry(db, registry);
}

async function assertSafeToSeed(container: Container, target: DemoTarget, registry: DemoRegistry | null): Promise<void> {
  const { db } = container;
  if (registry && registry.targetId && registry.targetId !== target.targetId) {
    throw new DemoEnvironmentError(`The demo registry in this database belongs to ${registry.targetId}, not to ${target.targetId}`);
  }
  const registeredUsers = new Set(registry?.userIds ?? []);
  const registeredInstitutions = new Set(registry?.institutionIds ?? []);
  for (const account of Object.values(demoAccounts)) {
    const existing = await db.user.findUnique({ where: { email: account.email }, select: { id: true } });
    if (existing && !registeredUsers.has(existing.id)) {
      throw new DemoEnvironmentError(`The account ${account.email} already exists and was not created by the demo seed; it will not be modified`);
    }
  }
  for (const slug of [DEMO_INSTITUTION_SLUG, DEMO_EXTERNAL_INSTITUTION_SLUG]) {
    const existing = await db.institution.findUnique({ where: { slug }, select: { id: true } });
    if (existing && !registeredInstitutions.has(existing.id)) {
      throw new DemoEnvironmentError(`The institution ${slug} already exists and was not created by the demo seed; it will not be modified`);
    }
  }
  if (target.local || target.allowExistingData) return;
  const [otherUsers, otherInstitutions] = await Promise.all([
    db.user.count({ where: { id: { notIn: [...registeredUsers] }, NOT: { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } } } }),
    db.institution.count({ where: { id: { notIn: [...registeredInstitutions] }, isPlatform: false } }),
  ]);
  if (otherUsers > 0 || otherInstitutions > 0) {
    throw new DemoEnvironmentError(
      `This database already contains ${otherUsers} users and ${otherInstitutions} institutions that are not demo data. Set DEMO_ALLOW_EXISTING_DATA=true only if they are disposable test records.`,
    );
  }
}

async function upsertDemoUser(container: Container, account: { email: string; displayName: string }, passwordHash: string) {
  return container.db.user.upsert({
    where: { email: account.email },
    create: {
      email: account.email,
      displayName: account.displayName,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      passwordHash,
      passwordChangedAt: new Date(),
      profile: { create: { headline: "Cuenta de demostración" } },
      preference: { create: { locale: "es", timezone: "America/Mexico_City", currency: "MXN" } },
    },
    update: { displayName: account.displayName, status: UserStatus.ACTIVE, passwordHash, passwordChangedAt: new Date(), deletedAt: null, mfaEnabled: false },
  });
}

async function assignRole(container: Container, userId: string, roleKey: string, scope: { type: RoleScope; institutionId?: string; courseId?: string }) {
  const role = await container.db.role.findFirstOrThrow({ where: { key: roleKey, institutionId: null } });
  const scopeKey = scopeKeyFor({ type: scope.type, institutionId: scope.institutionId, courseId: scope.courseId });
  await container.db.roleAssignment.upsert({
    where: { userId_roleId_scopeKey: { userId, roleId: role.id, scopeKey } },
    create: { userId, roleId: role.id, scopeType: scope.type, scopeKey, institutionId: scope.institutionId ?? null, courseId: scope.courseId ?? null },
    update: { expiresAt: null },
  });
}

async function addMember(container: Container, institutionId: string, userId: string, memberType: MemberType) {
  await container.db.institutionMembership.upsert({
    where: { institutionId_userId: { institutionId, userId } },
    create: { institutionId, userId, memberType, status: MembershipStatus.ACTIVE, joinedAt: new Date() },
    update: { memberType, status: MembershipStatus.ACTIVE },
  });
}

interface QuestionSeed {
  type: QuestionType;
  prompt: string;
  explanation?: string;
  config?: Record<string, unknown>;
  options?: Array<{ text: string; isCorrect?: boolean }>;
}

interface CourseSeed {
  institutionId: string;
  slug: string;
  title: string;
  summary: string;
  status: CourseStatus;
  visibility: CourseVisibility;
  categoryId: string | null;
  teacherId: string;
  certificateEnabled: boolean;
  lessons: Array<{ title: string; type: LessonType; body?: string; contentUrl?: string; durationSeconds?: number; isPreview?: boolean }>;
  assessment?: { title: string; maxAttempts: number; passingScorePercent: number; questions: QuestionSeed[] };
}

async function createCourse(container: Container, seed: CourseSeed) {
  const { db } = container;
  const existing = await db.course.findFirst({ where: { institutionId: seed.institutionId, slug: seed.slug } });
  if (existing) return { course: existing, created: false };
  const published = seed.status === CourseStatus.PUBLISHED;
  const course = await db.course.create({
    data: {
      institutionId: seed.institutionId,
      slug: seed.slug,
      title: seed.title,
      summary: seed.summary,
      description: `## ${seed.title}\n\n${seed.summary}`,
      level: CourseLevel.BEGINNER,
      status: seed.status,
      visibility: seed.visibility,
      enrollmentPolicy: EnrollmentPolicy.OPEN,
      publishedAt: published ? new Date() : null,
      certificateEnabled: seed.certificateEnabled,
      estimatedMinutes: 90,
      categoryId: seed.categoryId,
      createdById: seed.teacherId,
    },
  });
  await assignRole(container, seed.teacherId, SystemRole.CourseInstructor, { type: RoleScope.COURSE, institutionId: seed.institutionId, courseId: course.id });
  const module = await db.courseModule.create({ data: { courseId: course.id, position: 1, title: "Módulo 1" } });
  const unit = await db.courseUnit.create({ data: { moduleId: module.id, courseId: course.id, position: 1, title: "Unidad 1" } });
  const lessonStatus = published ? ContentStatus.PUBLISHED : ContentStatus.DRAFT;
  let position = 0;
  for (const lesson of seed.lessons) {
    position += 1;
    await db.lesson.create({
      data: {
        unitId: unit.id,
        moduleId: module.id,
        courseId: course.id,
        position,
        title: lesson.title,
        type: lesson.type,
        status: lessonStatus,
        isPreview: lesson.isPreview ?? false,
        body: lesson.body ?? null,
        contentUrl: lesson.contentUrl ?? null,
        durationSeconds: lesson.durationSeconds ?? null,
      },
    });
  }
  if (seed.assessment) {
    const bank = await db.questionBank.create({ data: { institutionId: seed.institutionId, courseId: course.id, title: `Banco · ${seed.title}`, createdById: seed.teacherId } });
    const questionIds: string[] = [];
    for (const question of seed.assessment.questions) {
      const created = await db.question.create({
        data: {
          bankId: bank.id,
          type: question.type,
          status: "ACTIVE",
          prompt: question.prompt,
          explanation: question.explanation ?? null,
          config: (question.config ?? {}) as Prisma.InputJsonValue,
          createdById: seed.teacherId,
          options: question.options ? { create: question.options.map((option, index) => ({ position: index + 1, text: option.text, isCorrect: option.isCorrect ?? false })) } : undefined,
        },
      });
      questionIds.push(created.id);
    }
    const assessment = await db.assessment.create({
      data: {
        courseId: course.id,
        institutionId: seed.institutionId,
        title: seed.assessment.title,
        status: published ? AssessmentStatus.PUBLISHED : AssessmentStatus.DRAFT,
        publishedAt: published ? new Date() : null,
        maxAttempts: seed.assessment.maxAttempts,
        passingScorePercent: seed.assessment.passingScorePercent,
        createdById: seed.teacherId,
        items: { create: questionIds.map((questionId, index) => ({ position: index + 1, kind: "FIXED", questionId })) },
      },
    });
    await db.lesson.create({
      data: { unitId: unit.id, moduleId: module.id, courseId: course.id, position: position + 1, title: seed.assessment.title, type: LessonType.ASSESSMENT, status: lessonStatus, assessmentId: assessment.id },
    });
  }
  return { course, created: true };
}

function correctResponse(type: string, key: AnswerKey): Record<string, unknown> {
  switch (type) {
    case QuestionType.SINGLE_CHOICE:
      return { optionId: key.correctOptionIds?.[0] };
    case QuestionType.MULTIPLE_CHOICE:
      return { optionIds: key.correctOptionIds ?? [] };
    case QuestionType.TRUE_FALSE:
      return { value: key.booleanAnswer };
    case QuestionType.ESSAY:
      return { text: "La capa de red decide la ruta y la capa de transporte garantiza la entrega extremo a extremo." };
    default:
      return {};
  }
}

async function answerAttempt(container: Container, userId: string, attemptId: string, limit?: number) {
  const questions = await container.db.attemptQuestion.findMany({ where: { attemptId }, orderBy: { position: "asc" } });
  for (const question of questions.slice(0, limit ?? questions.length)) {
    const response = correctResponse(question.type, question.answerKey as unknown as AnswerKey);
    await container.attempts.saveAnswer(userId, attemptId, question.id, response, seedMeta);
  }
}

async function learnerJourney(container: Container, userId: string, courseId: string, options: { completeContent: boolean; submit: boolean; answered?: number }) {
  const { db } = container;
  const existing = await db.enrollment.findUnique({ where: { userId_courseId: { userId, courseId } } });
  if (!existing) await container.enrollments.enroll(userId, courseId, {}, seedMeta);
  if (options.completeContent) {
    const lessons = await db.lesson.findMany({ where: { courseId, type: { not: LessonType.ASSESSMENT }, status: ContentStatus.PUBLISHED }, orderBy: { position: "asc" } });
    for (const lesson of lessons) await container.progress.complete(userId, lesson.id, seedMeta);
  }
  const assessment = await db.assessment.findFirst({ where: { courseId, status: AssessmentStatus.PUBLISHED } });
  if (!assessment) return;
  const previous = await db.assessmentAttempt.count({ where: { assessmentId: assessment.id, userId } });
  if (previous > 0) return;
  const attempt = await container.attempts.start(userId, assessment.id, seedMeta);
  await answerAttempt(container, userId, attempt.id, options.answered);
  if (options.submit) await container.attempts.submit(userId, attempt.id, seedMeta);
}

export interface DemoSummary {
  database: string;
  password: string;
  accounts: Record<DemoAccountKey, string>;
  institutions: { demo: string; external: string };
  courses: Record<string, { id: string; status: string }>;
  programId: string;
}

export async function seedDemoData(container: Container, target: DemoTarget): Promise<DemoSummary> {
  const { db } = container;
  await assertSafeToSeed(container, target, await readDemoRegistry(db));
  await syncSystemRoles(db);
  await ensurePlatformInstitution(db);
  const passwordHash = await container.passwordHasher.hash(target.password);
  const users = {} as Record<DemoAccountKey, { id: string }>;
  for (const [key, account] of Object.entries(demoAccounts) as Array<[DemoAccountKey, { email: string; displayName: string }]>) {
    users[key] = await upsertDemoUser(container, account, passwordHash);
    await registerDemoRecords(db, target, { userIds: [users[key].id] });
  }

  const institution = await db.institution.upsert({
    where: { slug: DEMO_INSTITUTION_SLUG },
    create: { slug: DEMO_INSTITUTION_SLUG, name: "Instituto Demo", type: InstitutionType.UNIVERSITY, defaultLocale: "es", defaultTimezone: "America/Mexico_City", defaultCurrency: "MXN" },
    update: { status: "ACTIVE" },
  });
  const external = await db.institution.upsert({
    where: { slug: DEMO_EXTERNAL_INSTITUTION_SLUG },
    create: { slug: DEMO_EXTERNAL_INSTITUTION_SLUG, name: "Colegio Demo", type: InstitutionType.SCHOOL, defaultLocale: "es", defaultTimezone: "America/Mexico_City", defaultCurrency: "MXN" },
    update: { status: "ACTIVE" },
  });
  await registerDemoRecords(db, target, { institutionIds: [institution.id, external.id] });

  await assignRole(container, users.platformAdmin.id, SystemRole.PlatformAdmin, { type: RoleScope.PLATFORM });
  const memberships: Array<[DemoAccountKey, string, MemberType, string]> = [
    ["institutionAdmin", institution.id, MemberType.ADMIN, SystemRole.InstitutionAdmin],
    ["teacher", institution.id, MemberType.TEACHER, SystemRole.Teacher],
    ["student", institution.id, MemberType.STUDENT, SystemRole.Student],
    ["secondStudent", institution.id, MemberType.STUDENT, SystemRole.Student],
    ["externalAdmin", external.id, MemberType.ADMIN, SystemRole.InstitutionAdmin],
  ];
  for (const [key, institutionId, memberType, roleKey] of memberships) {
    await addMember(container, institutionId, users[key].id, memberType);
    await assignRole(container, users[key].id, roleKey, { type: RoleScope.INSTITUTION, institutionId });
  }
  for (const key of Object.keys(users) as DemoAccountKey[]) await container.authz.invalidate(users[key].id);

  const networking = await db.category.upsert({
    where: { institutionId_slug: { institutionId: institution.id, slug: "redes" } },
    create: { institutionId: institution.id, slug: "redes", names: { es: "Redes", en: "Networking" } },
    update: {},
  });
  const programming = await db.category.upsert({
    where: { institutionId_slug: { institutionId: institution.id, slug: "programacion" } },
    create: { institutionId: institution.id, slug: "programacion", names: { es: "Programación", en: "Programming" } },
    update: {},
  });

  const networkingCourse = await createCourse(container, {
    institutionId: institution.id,
    slug: "demo-fundamentos-de-redes",
    title: "Fundamentos de redes (demo)",
    summary: "Modelos de referencia, direccionamiento y protocolos esenciales.",
    status: CourseStatus.PUBLISHED,
    visibility: CourseVisibility.PUBLIC,
    categoryId: networking.id,
    teacherId: users.teacher.id,
    certificateEnabled: true,
    lessons: [
      { title: "Introducción", type: LessonType.ARTICLE, body: "Las redes permiten compartir información entre dispositivos.", isPreview: true },
      { title: "El modelo OSI", type: LessonType.VIDEO, contentUrl: "https://videos.example.com/demo/osi.mp4", durationSeconds: 480 },
    ],
    assessment: {
      title: "Evaluación de redes",
      maxAttempts: 3,
      passingScorePercent: 60,
      questions: [
        { type: QuestionType.SINGLE_CHOICE, prompt: "¿Qué capa del modelo OSI se encarga del enrutamiento?", explanation: "La capa de red decide el camino de los paquetes.", options: [{ text: "Física" }, { text: "Red", isCorrect: true }, { text: "Aplicación" }] },
        { type: QuestionType.TRUE_FALSE, prompt: "TCP garantiza la entrega ordenada de los datos.", config: { answer: true } },
        { type: QuestionType.MULTIPLE_CHOICE, prompt: "¿Cuáles son protocolos de la capa de transporte?", config: { partialCredit: true }, options: [{ text: "TCP", isCorrect: true }, { text: "UDP", isCorrect: true }, { text: "HTTP" }] },
      ],
    },
  });
  const programmingCourse = await createCourse(container, {
    institutionId: institution.id,
    slug: "demo-introduccion-a-la-programacion",
    title: "Introducción a la programación (demo)",
    summary: "Variables, control de flujo y funciones con ejercicios guiados.",
    status: CourseStatus.PUBLISHED,
    visibility: CourseVisibility.INSTITUTION,
    categoryId: programming.id,
    teacherId: users.teacher.id,
    certificateEnabled: true,
    lessons: [{ title: "Primeros pasos", type: LessonType.ARTICLE, body: "Un programa es una secuencia de instrucciones." }],
    assessment: {
      title: "Ensayo de programación",
      maxAttempts: 2,
      passingScorePercent: 70,
      questions: [
        { type: QuestionType.ESSAY, prompt: "Explica con tus palabras qué es una función.", config: { minWords: 5, maxWords: 300 } },
        { type: QuestionType.SINGLE_CHOICE, prompt: "¿Qué estructura repite instrucciones?", options: [{ text: "Un ciclo", isCorrect: true }, { text: "Una constante" }] },
      ],
    },
  });
  const draftCourse = await createCourse(container, {
    institutionId: institution.id,
    slug: "demo-seguridad-avanzada",
    title: "Seguridad informática avanzada (borrador demo)",
    summary: "Curso en preparación, visible solo para el personal.",
    status: CourseStatus.DRAFT,
    visibility: CourseVisibility.PUBLIC,
    categoryId: networking.id,
    teacherId: users.teacher.id,
    certificateEnabled: false,
    lessons: [{ title: "Modelado de amenazas", type: LessonType.ARTICLE, body: "Borrador." }],
  });
  const externalCourse = await createCourse(container, {
    institutionId: external.id,
    slug: "demo-curso-interno-colegio",
    title: "Curso interno del colegio (demo)",
    summary: "Solo visible para miembros del colegio de demostración.",
    status: CourseStatus.PUBLISHED,
    visibility: CourseVisibility.INSTITUTION,
    categoryId: null,
    teacherId: users.externalAdmin.id,
    certificateEnabled: false,
    lessons: [{ title: "Bienvenida", type: LessonType.ARTICLE, body: "Contenido interno." }],
  });

  const program = await db.program.upsert({
    where: { institutionId_slug: { institutionId: institution.id, slug: "demo-ruta-infraestructura" } },
    create: {
      institutionId: institution.id,
      slug: "demo-ruta-infraestructura",
      title: "Ruta de infraestructura (demo)",
      summary: "Programa que agrupa los cursos de redes y programación.",
      status: ContentStatus.PUBLISHED,
      publishedAt: new Date(),
      createdById: users.teacher.id,
      courses: {
        create: [
          { courseId: networkingCourse.course.id, position: 1 },
          { courseId: programmingCourse.course.id, position: 2 },
        ],
      },
    },
    update: {},
  });

  await learnerJourney(container, users.student.id, networkingCourse.course.id, { completeContent: true, submit: true });
  await learnerJourney(container, users.student.id, programmingCourse.course.id, { completeContent: true, submit: true });
  await learnerJourney(container, users.secondStudent.id, networkingCourse.course.id, { completeContent: false, submit: false, answered: 1 });

  const accounts = Object.fromEntries(Object.entries(demoAccounts).map(([key, account]) => [key, account.email])) as Record<DemoAccountKey, string>;
  return {
    database: target.targetId,
    password: target.password,
    accounts,
    institutions: { demo: institution.id, external: external.id },
    courses: {
      networking: { id: networkingCourse.course.id, status: networkingCourse.course.status },
      programming: { id: programmingCourse.course.id, status: programmingCourse.course.status },
      draft: { id: draftCourse.course.id, status: draftCourse.course.status },
      external: { id: externalCourse.course.id, status: externalCourse.course.status },
    },
    programId: program.id,
  };
}

export interface DemoRemoval {
  users: number;
  institutions: number;
  courses: number;
  files: number;
}

export async function removeDemoData(container: Container): Promise<DemoRemoval> {
  const { db } = container;
  const registry = await readDemoRegistry(db);
  if (!registry) return { users: 0, institutions: 0, courses: 0, files: 0 };
  const users = await db.user.findMany({ where: { id: { in: registry.userIds }, email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } }, select: { id: true } });
  const institutions = await db.institution.findMany({ where: { id: { in: registry.institutionIds }, slug: { in: [DEMO_INSTITUTION_SLUG, DEMO_EXTERNAL_INSTITUTION_SLUG] } }, select: { id: true } });
  const userIds = users.map((user) => user.id);
  const institutionIds = institutions.map((institution) => institution.id);
  const courses = await db.course.findMany({ where: { institutionId: { in: institutionIds } }, select: { id: true } });
  const courseIds = courses.map((course) => course.id);
  const files = await db.file.findMany({ where: { OR: [{ ownerId: { in: userIds } }, { institutionId: { in: institutionIds } }] }, select: { id: true, objectKey: true, quarantineKey: true } });
  const sessionIds = (await db.session.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((session) => session.id);
  await db.$transaction(
    async (tx) => {
      const programIds = (await tx.program.findMany({ where: { institutionId: { in: institutionIds } }, select: { id: true } })).map((program) => program.id);
      const assessmentIds = (await tx.assessment.findMany({ where: { institutionId: { in: institutionIds } }, select: { id: true } })).map((assessment) => assessment.id);
      const bankIds = (await tx.questionBank.findMany({ where: { institutionId: { in: institutionIds } }, select: { id: true } })).map((bank) => bank.id);
      await tx.certificate.deleteMany({ where: { OR: [{ courseId: { in: courseIds } }, { programId: { in: programIds } }, { userId: { in: userIds } }] } });
      await tx.programEnrollment.deleteMany({ where: { OR: [{ programId: { in: programIds } }, { userId: { in: userIds } }] } });
      await tx.assessmentAttempt.deleteMany({ where: { OR: [{ assessmentId: { in: assessmentIds } }, { userId: { in: userIds } }] } });
      await tx.assessmentResult.deleteMany({ where: { OR: [{ assessmentId: { in: assessmentIds } }, { userId: { in: userIds } }] } });
      await tx.lesson.updateMany({ where: { assessmentId: { in: assessmentIds } }, data: { assessmentId: null } });
      await tx.assessment.deleteMany({ where: { id: { in: assessmentIds } } });
      await tx.question.deleteMany({ where: { bankId: { in: bankIds } } });
      await tx.questionBank.deleteMany({ where: { id: { in: bankIds } } });
      await tx.enrollment.deleteMany({ where: { OR: [{ courseId: { in: courseIds } }, { userId: { in: userIds } }] } });
      await tx.program.deleteMany({ where: { id: { in: programIds } } });
      await tx.course.deleteMany({ where: { id: { in: courseIds } } });
      await tx.file.deleteMany({ where: { id: { in: files.map((file) => file.id) } } });
      await tx.conversation.deleteMany({ where: { createdById: { in: userIds }, participants: { every: { userId: { in: userIds } } } } });
      await tx.institution.deleteMany({ where: { id: { in: institutionIds } } });
      await tx.privacyRequest.deleteMany({ where: { userId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.platformSetting.deleteMany({ where: { key: REGISTRY_KEY } });
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  for (const file of files) {
    await container.storage.delete(file.objectKey).catch(() => undefined);
    if (file.quarantineKey) await container.storage.delete(file.quarantineKey).catch(() => undefined);
  }
  await container.sessionStore.invalidate(sessionIds);
  for (const userId of userIds) await container.authz.invalidate(userId);
  return { users: userIds.length, institutions: institutionIds.length, courses: courseIds.length, files: files.length };
}

export async function demoAttemptStates(container: Container): Promise<Record<string, number>> {
  const rows = await container.db.assessmentAttempt.groupBy({ by: ["status"], where: { user: { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } } }, _count: { _all: true } });
  const states: Record<string, number> = {};
  for (const status of Object.values(AttemptStatus)) states[status] = 0;
  for (const row of rows) states[row.status] = row._count._all;
  const enrollments = await container.db.enrollment.groupBy({ by: ["status"], where: { user: { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } } }, _count: { _all: true } });
  for (const status of Object.values(EnrollmentStatus)) states[`enrollment:${status}`] = 0;
  for (const row of enrollments) states[`enrollment:${row.status}`] = row._count._all;
  return states;
}
