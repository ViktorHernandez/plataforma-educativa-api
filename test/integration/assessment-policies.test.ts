import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { academicWorld, publishedCourse } from "../helpers/academic.js";
import { takeAttempt, trueFalseAssessment } from "../helpers/assessments.js";
import { createTestContext, json, resetState, type TestContext } from "../helpers/test-app.js";

let ctx: TestContext;
let world: Awaited<ReturnType<typeof academicWorld>>;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  vi.useRealTimers();
  await resetState(ctx.container);
  world = await academicWorld(ctx.app, ctx.container);
});

async function enrolledAssessment(overrides: Record<string, unknown> = {}, withLesson = false) {
  const { course, unitId } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id, {}, [{ title: "Lectura", type: "ARTICLE", body: "Texto" }]);
  const assessment = await trueFalseAssessment(ctx.app, world.teacher.headers, world.institution.id, course.id, overrides);
  let lessonId: string | null = null;
  if (withLesson) {
    const lesson = await ctx.app.inject({ method: "POST", url: `/v1/units/${unitId}/lessons`, headers: world.teacher.headers, payload: { title: "Quiz", type: "ASSESSMENT", assessmentId: assessment.id, status: "PUBLISHED" } });
    lessonId = json(lesson).data.id;
  }
  const enrollment = json(await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers })).data;
  return { course, assessment, enrollmentId: enrollment.id as string, lessonId };
}

async function result(assessmentId: string) {
  return ctx.container.db.assessmentResult.findUniqueOrThrow({ where: { assessmentId_userId: { assessmentId, userId: world.student.user.id } } });
}

function voidAttempt(attemptId: string, headers = world.teacher.headers) {
  return ctx.app.inject({ method: "POST", url: `/v1/attempts/${attemptId}/void`, headers, payload: { reason: "Irregularidad detectada" } });
}

describe("voiding attempts", () => {
  it("recalculates the result, the final grade and the attempt allowance", async () => {
    const { assessment, enrollmentId } = await enrolledAssessment({ maxAttempts: 2 });
    const failed = await takeAttempt(ctx.app, world.student.headers, assessment.id, false);
    const passed = await takeAttempt(ctx.app, world.student.headers, assessment.id, true);
    expect(Number((await result(assessment.id)).scorePercent)).toBe(100);
    const exhausted = await ctx.app.inject({ method: "POST", url: `/v1/assessments/${assessment.id}/attempts`, headers: world.student.headers });
    expect(json(exhausted).error.code).toBe("ATTEMPTS_EXHAUSTED");

    const studentVoid = await voidAttempt(passed.id, world.student.headers);
    expect(studentVoid.statusCode).toBe(404);
    const voided = await voidAttempt(passed.id);
    expect(voided.statusCode).toBe(200);
    expect(json(voided).data.result).toMatchObject({ attemptsCount: 1, gradedAttempts: 1, scorePercent: 0, passed: false, lastAttemptId: failed.id });
    const recalculated = await result(assessment.id);
    expect(Number(recalculated.scorePercent)).toBe(0);
    expect(recalculated.passed).toBe(false);
    expect(recalculated.attemptsCount).toBe(1);
    const enrollment = await ctx.container.db.enrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
    expect(Number(enrollment.finalScorePercent)).toBe(0);

    const retake = await takeAttempt(ctx.app, world.student.headers, assessment.id, true);
    const stored = await ctx.container.db.assessmentAttempt.findUniqueOrThrow({ where: { id: retake.id } });
    expect(stored.attemptNumber).toBe(3);
    expect(Number((await result(assessment.id)).scorePercent)).toBe(100);

    const repeat = await voidAttempt(passed.id);
    expect(json(repeat).data.result).toBeNull();
    const audit = await ctx.container.db.auditLog.findMany({ where: { action: "assessment.attempt.voided" } });
    expect(audit).toHaveLength(1);
    expect(await ctx.container.db.activityEvent.count({ where: { verb: "assessment.attempt.voided" } })).toBe(1);
  });

  it("clears the result when the only attempt is voided and frees an open attempt", async () => {
    const { assessment } = await enrolledAssessment({ maxAttempts: 1 });
    const open = await takeAttempt(ctx.app, world.student.headers, assessment.id, null);
    const voided = json(await voidAttempt(open.id)).data.result;
    expect(voided).toMatchObject({ attemptsCount: 0, gradedAttempts: 0, scorePercent: null, passed: null, lastAttemptId: null });
    const saved = await ctx.app.inject({ method: "PUT", url: `/v1/attempts/${open.id}/answers/${open.questions[0]!.id}`, headers: world.student.headers, payload: { response: { value: true } } });
    expect(saved.statusCode).toBe(409);
    await ctx.container.db.outboxEvent.updateMany({ where: { type: "assessment.attempt.autosubmit" }, data: { availableAt: new Date(Date.now() - 1000) } });
    await ctx.outbox.drain();
    expect((await ctx.container.db.assessmentAttempt.findUniqueOrThrow({ where: { id: open.id } })).status).toBe("VOIDED");
    const fresh = await takeAttempt(ctx.app, world.student.headers, assessment.id, true);
    expect(fresh.id).not.toBe(open.id);
    expect((await result(assessment.id)).passed).toBe(true);
  });

  it("reopens the assessment lesson when the passing attempt is voided", async () => {
    const { assessment, enrollmentId, lessonId } = await enrolledAssessment({ maxAttempts: 3 }, true);
    const passed = await takeAttempt(ctx.app, world.student.headers, assessment.id, true);
    const progress = await ctx.container.db.lessonProgress.findFirstOrThrow({ where: { enrollmentId, lessonId: lessonId! } });
    expect(progress.status).toBe("COMPLETED");
    await voidAttempt(passed.id);
    const reopened = await ctx.container.db.lessonProgress.findFirstOrThrow({ where: { enrollmentId, lessonId: lessonId! } });
    expect(reopened.status).toBe("IN_PROGRESS");
    await takeAttempt(ctx.app, world.student.headers, assessment.id, true);
    expect((await ctx.container.db.lessonProgress.findFirstOrThrow({ where: { enrollmentId, lessonId: lessonId! } })).status).toBe("COMPLETED");
  });
});

describe("extra time accommodations", () => {
  it("lets authorized teachers grant extra time that applies to new and open attempts", async () => {
    const { assessment } = await enrolledAssessment({ timeLimitSeconds: 600, gracePeriodSeconds: 0 });
    const url = `/v1/assessments/${assessment.id}/accommodations/${world.student.user.id}`;
    const byStudent = await ctx.app.inject({ method: "PUT", url, headers: world.student.headers, payload: { extraTimeSeconds: 300 } });
    expect(byStudent.statusCode).toBe(404);
    const byOutsider = await ctx.app.inject({ method: "PUT", url, headers: world.outsider.headers, payload: { extraTimeSeconds: 300 } });
    expect(byOutsider.statusCode).toBe(404);
    const notEnrolled = await ctx.app.inject({ method: "PUT", url: `/v1/assessments/${assessment.id}/accommodations/${world.secondStudent.user.id}`, headers: world.teacher.headers, payload: { extraTimeSeconds: 300 } });
    expect(notEnrolled.statusCode).toBe(404);
    const tooMuch = await ctx.app.inject({ method: "PUT", url, headers: world.teacher.headers, payload: { extraTimeSeconds: 90_000 } });
    expect(tooMuch.statusCode).toBe(400);

    const open = await takeAttempt(ctx.app, world.student.headers, assessment.id, null);
    const initialDeadline = new Date(open.deadlineAt!).getTime();
    const granted = await ctx.app.inject({ method: "PUT", url, headers: world.teacher.headers, payload: { extraTimeSeconds: 300, reason: "Plan de apoyo" } });
    expect(granted.statusCode).toBe(200);
    const accommodation = json(granted).data;
    expect(accommodation.appliedToAttemptId).toBe(open.id);
    expect(accommodation.grantedById).toBe(world.teacher.user.id);
    const extended = await ctx.container.db.assessmentAttempt.findUniqueOrThrow({ where: { id: open.id } });
    expect(extended.deadlineAt!.getTime() - initialDeadline).toBeGreaterThanOrEqual(299_000);
    expect(extended.extraTimeSeconds).toBe(300);

    const pastForDatabase = new Date("2000-01-01T00:00:00Z");
    await ctx.container.db.outboxEvent.updateMany({ where: { type: "assessment.attempt.autosubmit", availableAt: { lt: extended.deadlineAt! } }, data: { availableAt: pastForDatabase } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(initialDeadline + 60_000));
    await ctx.outbox.drain();
    const stillOpen = await ctx.container.db.assessmentAttempt.findUniqueOrThrow({ where: { id: open.id } });
    expect(stillOpen.status).toBe("IN_PROGRESS");
    const answer = await ctx.app.inject({ method: "PUT", url: `/v1/attempts/${open.id}/answers/${open.questions[0]!.id}`, headers: world.student.headers, payload: { response: { value: true } } });
    expect(answer.statusCode).toBe(200);
    vi.setSystemTime(new Date(initialDeadline + 400_000));
    await ctx.container.db.outboxEvent.updateMany({ where: { type: "assessment.attempt.autosubmit", processedAt: null }, data: { availableAt: pastForDatabase } });
    await ctx.outbox.drain();
    vi.useRealTimers();
    const submitted = await ctx.container.db.assessmentAttempt.findUniqueOrThrow({ where: { id: open.id } });
    expect(submitted.status).toBe("GRADED");
    expect(submitted.autoSubmitted).toBe(true);

    const listed = json(await ctx.app.inject({ method: "GET", url: `/v1/assessments/${assessment.id}/accommodations`, headers: world.teacher.headers })).data;
    expect(listed).toHaveLength(1);
    expect(listed[0].learner.id).toBe(world.student.user.id);
    const audit = await ctx.container.db.auditLog.findFirstOrThrow({ where: { action: "assessment.accommodation.granted" } });
    expect(audit.actorId).toBe(world.teacher.user.id);
  });

  it("uses the accommodation for new attempts, caps it at the closing time and can be revoked", async () => {
    const closesAt = new Date(Date.now() + 15 * 60 * 1000);
    const { assessment } = await enrolledAssessment({ timeLimitSeconds: 600, gracePeriodSeconds: 0, closesAt: closesAt.toISOString(), maxAttempts: 3 });
    const url = `/v1/assessments/${assessment.id}/accommodations/${world.student.user.id}`;
    await ctx.app.inject({ method: "PUT", url, headers: world.teacher.headers, payload: { extraTimeSeconds: 3600 } });
    const capped = await takeAttempt(ctx.app, world.student.headers, assessment.id, null);
    expect(new Date(capped.deadlineAt!).getTime()).toBe(closesAt.getTime());
    await ctx.app.inject({ method: "POST", url: `/v1/attempts/${capped.id}/submit`, headers: world.student.headers });

    const revoked = await ctx.app.inject({ method: "DELETE", url, headers: world.teacher.headers });
    expect(revoked.statusCode).toBe(200);
    const again = await ctx.app.inject({ method: "DELETE", url, headers: world.teacher.headers });
    expect(again.statusCode).toBe(404);
    const normal = await takeAttempt(ctx.app, world.student.headers, assessment.id, null);
    const stored = await ctx.container.db.assessmentAttempt.findUniqueOrThrow({ where: { id: normal.id } });
    expect(stored.extraTimeSeconds).toBe(0);
    expect(stored.deadlineAt!.getTime() - stored.startedAt.getTime()).toBeLessThanOrEqual(600_000);
  });

  it("rejects extra time for untimed assessments", async () => {
    const { assessment } = await enrolledAssessment({ timeLimitSeconds: null });
    const response = await ctx.app.inject({ method: "PUT", url: `/v1/assessments/${assessment.id}/accommodations/${world.student.user.id}`, headers: world.teacher.headers, payload: { extraTimeSeconds: 300 } });
    expect(response.statusCode).toBe(409);
  });
});
