import type { Container } from "../../src/app/container.js";
import type { AppInstance } from "../../src/app/types.js";
import { MemberType, RoleScope } from "../../src/generated/prisma/enums.js";
import { addMember, bootstrap, createInstitution, createUserWithSession, grantRole } from "./factories.js";
import { json } from "./test-app.js";

export async function academicWorld(app: AppInstance, container: Container) {
  await bootstrap(container);
  const institution = await createInstitution(container);
  const otherInstitution = await createInstitution(container);

  const teacher = await createUserWithSession(app, container, { displayName: "Profesora Ruiz" });
  await addMember(container, institution.id, teacher.user.id, MemberType.TEACHER);
  await grantRole(container, teacher.user.id, "teacher", { type: RoleScope.INSTITUTION, institutionId: institution.id });

  const admin = await createUserWithSession(app, container, { displayName: "Admin Institucional" });
  await addMember(container, institution.id, admin.user.id, MemberType.ADMIN);
  await grantRole(container, admin.user.id, "institution_admin", { type: RoleScope.INSTITUTION, institutionId: institution.id });

  const student = await createUserWithSession(app, container, { displayName: "Estudiante Uno" });
  await addMember(container, institution.id, student.user.id, MemberType.STUDENT);
  await grantRole(container, student.user.id, "student", { type: RoleScope.INSTITUTION, institutionId: institution.id });

  const secondStudent = await createUserWithSession(app, container, { displayName: "Estudiante Dos" });
  await addMember(container, institution.id, secondStudent.user.id, MemberType.STUDENT);

  const outsider = await createUserWithSession(app, container, { displayName: "Otro Profesor" });
  await addMember(container, otherInstitution.id, outsider.user.id, MemberType.TEACHER);
  await grantRole(container, outsider.user.id, "institution_admin", { type: RoleScope.INSTITUTION, institutionId: otherInstitution.id });

  return { institution, otherInstitution, teacher, admin, student, secondStudent, outsider };
}

export async function publishedCourse(
  app: AppInstance,
  headers: Record<string, string>,
  institutionId: string,
  overrides: Record<string, unknown> = {},
  lessons: Array<Record<string, unknown>> = [
    { title: "Introducción", type: "ARTICLE", body: "# Hola\nContenido del curso", isPreview: true },
    { title: "Video principal", type: "VIDEO", contentUrl: "https://videos.example.com/intro.mp4", durationSeconds: 600 },
  ],
) {
  const slug = `curso-${Math.random().toString(36).slice(2, 10)}`;
  const created = await app.inject({ method: "POST", url: `/v1/institutions/${institutionId}/courses`, headers, payload: { slug, title: "Fundamentos de Redes", ...overrides } });
  if (created.statusCode !== 201) throw new Error(`Course creation failed ${created.statusCode} ${created.body}`);
  const course = json(created).data;
  const module = json(await app.inject({ method: "POST", url: `/v1/courses/${course.id}/modules`, headers, payload: { title: "Módulo 1" } })).data;
  const unit = json(await app.inject({ method: "POST", url: `/v1/modules/${module.id}/units`, headers, payload: { title: "Unidad 1" } })).data;
  const lessonIds: string[] = [];
  for (const lesson of lessons) {
    const response = await app.inject({ method: "POST", url: `/v1/units/${unit.id}/lessons`, headers, payload: { ...lesson, status: "PUBLISHED" } });
    if (response.statusCode !== 201) throw new Error(`Lesson creation failed ${response.statusCode} ${response.body}`);
    lessonIds.push(json(response).data.id);
  }
  const publish = await app.inject({ method: "POST", url: `/v1/courses/${course.id}/status`, headers, payload: { status: "PUBLISHED" } });
  if (publish.statusCode !== 200) throw new Error(`Publish failed ${publish.statusCode} ${publish.body}`);
  return { course: json(publish).data, moduleId: module.id as string, unitId: unit.id as string, lessonIds };
}
