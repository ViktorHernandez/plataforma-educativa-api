import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemberType } from "../../src/generated/prisma/enums.js";
import { academicWorld, publishedCourse } from "../helpers/academic.js";
import { addMember, bearer, createUserWithSession, DEFAULT_PASSWORD, login, uniqueEmail } from "../helpers/factories.js";
import { createTestContext, extractToken, json, resetState, type TestContext } from "../helpers/test-app.js";

let ctx: TestContext;
let world: Awaited<ReturnType<typeof academicWorld>>;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetState(ctx.container);
  ctx.mail.clear();
  world = await academicWorld(ctx.app, ctx.container);
});

describe("course authoring and catalog", () => {
  it("lets a teacher build and publish a course that appears in the public catalog", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const anonymous = await ctx.app.inject({ method: "GET", url: "/v1/catalog/courses" });
    expect(anonymous.statusCode).toBe(200);
    expect(json(anonymous).data.map((item: { id: string }) => item.id)).toContain(course.id);
    const detail = await ctx.app.inject({ method: "GET", url: `/v1/catalog/courses/${course.id}` });
    expect(json(detail).data.instructors[0].displayName).toBe("Profesora Ruiz");
    expect(json(detail).data.enrollmentOpen).toBe(true);
    const search = await ctx.app.inject({ method: "GET", url: "/v1/catalog/courses?q=redes" });
    expect(json(search).meta.total).toBe(1);
  });

  it("hides institution-only courses from outsiders and anonymous users", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id, { visibility: "INSTITUTION" });
    const anonymous = await ctx.app.inject({ method: "GET", url: `/v1/catalog/courses/${course.id}` });
    expect(anonymous.statusCode).toBe(404);
    const outsider = await ctx.app.inject({ method: "GET", url: `/v1/catalog/courses/${course.id}`, headers: world.outsider.headers });
    expect(outsider.statusCode).toBe(404);
    const member = await ctx.app.inject({ method: "GET", url: `/v1/catalog/courses/${course.id}`, headers: world.student.headers });
    expect(member.statusCode).toBe(200);
  });

  it("prevents cross-institution management and students from editing", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const outsiderPatch = await ctx.app.inject({ method: "PATCH", url: `/v1/courses/${course.id}`, headers: world.outsider.headers, payload: { title: "Hackeado" } });
    expect(outsiderPatch.statusCode).toBe(404);
    const studentPatch = await ctx.app.inject({ method: "PATCH", url: `/v1/courses/${course.id}`, headers: world.student.headers, payload: { title: "Hackeado" } });
    expect(studentPatch.statusCode).toBe(404);
    const outsiderCreate = await ctx.app.inject({
      method: "POST",
      url: `/v1/institutions/${world.institution.id}/courses`,
      headers: world.outsider.headers,
      payload: { slug: "intruso", title: "Curso intruso" },
    });
    expect(outsiderCreate.statusCode).toBe(404);
  });

  it("uses optimistic concurrency on course updates", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const first = await ctx.app.inject({ method: "PATCH", url: `/v1/courses/${course.id}`, headers: { ...world.teacher.headers, "if-match": `"${course.version}"` }, payload: { subtitle: "Uno" } });
    expect(first.statusCode).toBe(200);
    expect(first.headers["etag"]).toBe(`"${course.version + 1}"`);
    const stale = await ctx.app.inject({ method: "PATCH", url: `/v1/courses/${course.id}`, headers: { ...world.teacher.headers, "if-match": `"${course.version}"` }, payload: { subtitle: "Dos" } });
    expect(stale.statusCode).toBe(409);
    expect(json(stale).error.code).toBe("VERSION_CONFLICT");
  });

  it("rejects script injection in rich content", async () => {
    const { unitId } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const response = await ctx.app.inject({
      method: "POST",
      url: `/v1/units/${unitId}/lessons`,
      headers: world.teacher.headers,
      payload: { title: "Malicioso", type: "ARTICLE", body: 'Hola <img src=x onerror="alert(1)">' },
    });
    expect(response.statusCode).toBe(400);
    const link = await ctx.app.inject({
      method: "POST",
      url: `/v1/units/${unitId}/lessons`,
      headers: world.teacher.headers,
      payload: { title: "Enlace", type: "EXTERNAL_LINK", contentUrl: "javascript:alert(1)" },
    });
    expect(link.statusCode).toBe(400);
  });

  it("prevents prerequisite cycles", async () => {
    const a = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const b = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const first = await ctx.app.inject({ method: "PUT", url: `/v1/courses/${b.course.id}/prerequisites`, headers: world.teacher.headers, payload: { courseIds: [a.course.id] } });
    expect(first.statusCode).toBe(200);
    const cycle = await ctx.app.inject({ method: "PUT", url: `/v1/courses/${a.course.id}/prerequisites`, headers: world.teacher.headers, payload: { courseIds: [b.course.id] } });
    expect(cycle.statusCode).toBe(409);
  });
});

describe("enrollment", () => {
  it("enrolls idempotently and rejects duplicates", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const headers = { ...world.student.headers, "idempotency-key": "enroll-key-0000001" };
    const first = await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers });
    expect(first.statusCode).toBe(201);
    const replay = await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(json(replay).data.id).toBe(json(first).data.id);
    const duplicate = await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers });
    expect(duplicate.statusCode).toBe(409);
    expect(json(duplicate).error.code).toBe("ALREADY_ENROLLED");
  });

  it("never exceeds capacity under concurrent enrollment", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id, { capacity: 2 });
    const learners = await Promise.all(Array.from({ length: 6 }, () => createUserWithSession(ctx.app, ctx.container)));
    const responses = await Promise.all(learners.map((learner) => ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: learner.headers })));
    const created = responses.filter((response) => response.statusCode === 201);
    const full = responses.filter((response) => response.statusCode === 409 && json(response).error.code === "ENROLLMENT_FULL");
    expect(created).toHaveLength(2);
    expect(full).toHaveLength(4);
    const stored = await ctx.container.db.course.findUniqueOrThrow({ where: { id: course.id } });
    expect(stored.seatsTaken).toBe(2);
  });

  it("releases the seat when a learner cancels", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id, { capacity: 1 });
    const enrollment = json(await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers })).data;
    const blocked = await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.secondStudent.headers });
    expect(json(blocked).error.code).toBe("ENROLLMENT_FULL");
    const cancel = await ctx.app.inject({ method: "POST", url: `/v1/enrollments/${enrollment.id}/cancel`, headers: world.student.headers, payload: { reason: "Cambio de horario" } });
    expect(cancel.statusCode).toBe(200);
    const retry = await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.secondStudent.headers });
    expect(retry.statusCode).toBe(201);
    const history = await ctx.app.inject({ method: "GET", url: `/v1/enrollments/${enrollment.id}/history`, headers: world.student.headers });
    expect(json(history).data.map((event: { toStatus: string }) => event.toStatus)).toEqual(["ACTIVE", "CANCELLED"]);
  });

  it("requires approval when the course policy asks for it", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id, { enrollmentPolicy: "APPROVAL" });
    const request = await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers });
    const enrollment = json(request).data;
    expect(enrollment.status).toBe("PENDING_APPROVAL");
    const selfApprove = await ctx.app.inject({ method: "POST", url: `/v1/enrollments/${enrollment.id}/actions`, headers: world.student.headers, payload: { action: "approve" } });
    expect(selfApprove.statusCode).toBe(404);
    const approve = await ctx.app.inject({ method: "POST", url: `/v1/enrollments/${enrollment.id}/actions`, headers: world.teacher.headers, payload: { action: "approve" } });
    expect(json(approve).data.status).toBe("ACTIVE");
    const teacherNotifications = await ctx.container.db.notification.findMany({ where: { userId: world.teacher.user.id, type: "enrollment.requested" } });
    expect(teacherNotifications).toHaveLength(1);
  });

  it("enforces prerequisites", async () => {
    const basics = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const advanced = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    await ctx.app.inject({ method: "PUT", url: `/v1/courses/${advanced.course.id}/prerequisites`, headers: world.teacher.headers, payload: { courseIds: [basics.course.id] } });
    const blocked = await ctx.app.inject({ method: "POST", url: `/v1/courses/${advanced.course.id}/enrollments`, headers: world.student.headers });
    expect(blocked.statusCode).toBe(409);
    expect(json(blocked).error.code).toBe("PREREQUISITES_NOT_MET");
    await ctx.app.inject({ method: "POST", url: `/v1/courses/${basics.course.id}/enrollments`, headers: world.student.headers });
    for (const lessonId of basics.lessonIds) {
      await ctx.app.inject({ method: "POST", url: `/v1/lessons/${lessonId}/complete`, headers: world.student.headers });
    }
    const allowed = await ctx.app.inject({ method: "POST", url: `/v1/courses/${advanced.course.id}/enrollments`, headers: world.student.headers });
    expect(allowed.statusCode).toBe(201);
  });

  it("does not expose enrollments of other learners", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const enrollment = json(await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers })).data;
    for (const url of [`/v1/enrollments/${enrollment.id}`, `/v1/enrollments/${enrollment.id}/progress`, `/v1/enrollments/${enrollment.id}/history`]) {
      const response = await ctx.app.inject({ method: "GET", url, headers: world.secondStudent.headers });
      expect(response.statusCode).toBe(404);
    }
    const cancel = await ctx.app.inject({ method: "POST", url: `/v1/enrollments/${enrollment.id}/cancel`, headers: world.secondStudent.headers });
    expect(cancel.statusCode).toBe(404);
    const teacherView = await ctx.app.inject({ method: "GET", url: `/v1/enrollments/${enrollment.id}/progress`, headers: world.teacher.headers });
    expect(teacherView.statusCode).toBe(200);
    const roster = await ctx.app.inject({ method: "GET", url: `/v1/courses/${course.id}/enrollments`, headers: world.outsider.headers });
    expect(roster.statusCode).toBe(404);
  });
});

describe("content access and progress", () => {
  it("gates lesson content behind enrollment except previews", async () => {
    const { lessonIds } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const preview = await ctx.app.inject({ method: "GET", url: `/v1/lessons/${lessonIds[0]}` });
    expect(preview.statusCode).toBe(200);
    const locked = await ctx.app.inject({ method: "GET", url: `/v1/lessons/${lessonIds[1]}`, headers: world.student.headers });
    expect(locked.statusCode).toBe(403);
    expect(json(locked).error.code).toBe("NOT_ENROLLED");
  });

  it("tracks progress to completion and issues a verifiable certificate", async () => {
    const { course, lessonIds } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id, { certificateEnabled: true });
    const enrollment = json(await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers })).data;

    const heartbeat = await ctx.app.inject({
      method: "PUT",
      url: `/v1/lessons/${lessonIds[1]}/progress`,
      headers: world.student.headers,
      payload: { positionSeconds: 120, progressPercent: 20, timeSpentDeltaSeconds: 120 },
    });
    expect(json(heartbeat).data.status).toBe("IN_PROGRESS");
    const regress = await ctx.app.inject({ method: "PUT", url: `/v1/lessons/${lessonIds[1]}/progress`, headers: world.student.headers, payload: { progressPercent: 5 } });
    expect(json(regress).data.progressPercent).toBe(20);

    const partial = json(await ctx.app.inject({ method: "GET", url: `/v1/enrollments/${enrollment.id}/progress`, headers: world.student.headers })).data;
    expect(partial.progressPercent).toBe(0);
    expect(partial.resumeLessonId).toBe(lessonIds[1]);

    await ctx.app.inject({ method: "POST", url: `/v1/lessons/${lessonIds[0]}/complete`, headers: world.student.headers });
    const video = await ctx.app.inject({ method: "PUT", url: `/v1/lessons/${lessonIds[1]}/progress`, headers: world.student.headers, payload: { progressPercent: 95 } });
    expect(json(video).data.status).toBe("COMPLETED");

    const finished = json(await ctx.app.inject({ method: "GET", url: `/v1/enrollments/${enrollment.id}/progress`, headers: world.student.headers })).data;
    expect(finished.progressPercent).toBe(100);
    expect(finished.status).toBe("COMPLETED");
    expect(finished.modules[0].progressPercent).toBe(100);
    expect(finished.modules[0].units[0].progressPercent).toBe(100);

    const certificates = json(await ctx.app.inject({ method: "GET", url: "/v1/me/certificates", headers: world.student.headers })).data;
    expect(certificates).toHaveLength(1);
    const verification = await ctx.app.inject({ method: "GET", url: `/v1/certificates/verify/${certificates[0].verificationCode}` });
    expect(verification.statusCode).toBe(200);
    expect(json(verification).data.courseTitle).toBe("Fundamentos de Redes");

    await ctx.outbox.drain();
    const notifications = json(await ctx.app.inject({ method: "GET", url: "/v1/me/notifications", headers: { ...world.student.headers, "accept-language": "en" } })).data;
    const types = notifications.map((item: { type: string }) => item.type);
    expect(types).toEqual(expect.arrayContaining(["enrollment.activated", "course.completed", "certificate.issued"]));
  });
});

describe("institution administration", () => {
  it("invites a new member who completes account setup and signs in", async () => {
    const email = uniqueEmail("invited");
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/v1/institutions/${world.institution.id}/members`,
      headers: world.admin.headers,
      payload: { email, displayName: "Nuevo Docente", memberType: "TEACHER", externalId: "EMP-001" },
    });
    expect(invite.statusCode).toBe(201);
    expect(json(invite).data.invited).toBe(true);
    await ctx.outbox.drain();
    const token = extractToken(ctx.mail, email, "/account-setup");
    const setup = await ctx.app.inject({ method: "POST", url: "/v1/auth/password/setup", payload: { token, newPassword: DEFAULT_PASSWORD } });
    expect(setup.statusCode).toBe(200);
    const session = await login(ctx.app, email);
    const permissions = json(await ctx.app.inject({ method: "GET", url: "/v1/me/permissions", headers: bearer(session.accessToken) })).data;
    expect(permissions.some((grant: { role: string }) => grant.role === "teacher")).toBe(true);
  });

  it("blocks privilege escalation through role assignment", async () => {
    const roles = json(await ctx.app.inject({ method: "GET", url: `/v1/institutions/${world.institution.id}/roles`, headers: world.admin.headers })).data;
    const adminRole = roles.find((role: { key: string }) => role.key === "institution_admin");
    const teacherAttempt = await ctx.app.inject({
      method: "POST",
      url: `/v1/institutions/${world.institution.id}/role-assignments`,
      headers: world.teacher.headers,
      payload: { userId: world.teacher.user.id, roleId: adminRole.id },
    });
    expect(teacherAttempt.statusCode).toBe(403);
    const customRole = await ctx.app.inject({
      method: "POST",
      url: `/v1/institutions/${world.institution.id}/roles`,
      headers: world.admin.headers,
      payload: { key: "superpoder", name: "Súper poder", scope: "INSTITUTION", permissions: ["platform.settings.manage"] },
    });
    expect(customRole.statusCode).toBe(400);
    const crossTenant = await ctx.app.inject({
      method: "POST",
      url: `/v1/institutions/${world.institution.id}/role-assignments`,
      headers: world.outsider.headers,
      payload: { userId: world.outsider.user.id, roleId: adminRole.id },
    });
    expect(crossTenant.statusCode).toBe(404);
  });

  it("removes access immediately when a membership is suspended", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const members = json(await ctx.app.inject({ method: "GET", url: `/v1/institutions/${world.institution.id}/members?memberType=TEACHER`, headers: world.admin.headers })).data;
    const teacherMembership = members.find((member: { userId: string }) => member.userId === world.teacher.user.id);
    const suspend = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/institutions/${world.institution.id}/members/${teacherMembership.id}`,
      headers: world.admin.headers,
      payload: { status: "SUSPENDED" },
    });
    expect(suspend.statusCode).toBe(200);
    const edit = await ctx.app.inject({ method: "PATCH", url: `/v1/courses/${course.id}`, headers: world.teacher.headers, payload: { subtitle: "Sin permiso" } });
    expect(edit.statusCode).toBe(404);
  });

  it("keeps member listings scoped to the institution", async () => {
    await addMember(ctx.container, world.otherInstitution.id, world.student.user.id, MemberType.STUDENT);
    const response = await ctx.app.inject({ method: "GET", url: `/v1/institutions/${world.otherInstitution.id}/members`, headers: world.admin.headers });
    expect(response.statusCode).toBe(404);
  });
});
