import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { academicWorld, publishedCourse } from "../helpers/academic.js";
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

async function createBankWithQuestions() {
  const headers = world.teacher.headers;
  const bank = json(await ctx.app.inject({ method: "POST", url: `/v1/institutions/${world.institution.id}/question-banks`, headers, payload: { title: "Banco de redes" } })).data;
  const create = async (payload: Record<string, unknown>) => {
    const response = await ctx.app.inject({ method: "POST", url: `/v1/question-banks/${bank.id}/questions`, headers, payload });
    if (response.statusCode !== 201) throw new Error(`Question failed ${response.body}`);
    return json(response).data;
  };
  const single = await create({
    type: "SINGLE_CHOICE",
    prompt: "¿Qué capa del modelo OSI maneja el enrutamiento?",
    points: 2,
    explanation: "La capa de red decide rutas.",
    options: [
      { text: "Física", isCorrect: false },
      { text: "Red", isCorrect: true, feedback: "Correcto" },
      { text: "Aplicación", isCorrect: false },
    ],
  });
  const multiple = await create({
    type: "MULTIPLE_CHOICE",
    prompt: "Selecciona protocolos de transporte",
    points: 2,
    config: { partialCredit: true },
    options: [
      { text: "TCP", isCorrect: true },
      { text: "UDP", isCorrect: true },
      { text: "HTTP", isCorrect: false },
    ],
  });
  const trueFalse = await create({ type: "TRUE_FALSE", prompt: "IPv6 usa direcciones de 128 bits", config: { answer: true } });
  const short = await create({ type: "SHORT_ANSWER", prompt: "Protocolo de resolución de direcciones", config: { acceptedAnswers: ["ARP"] } });
  const numeric = await create({ type: "NUMERIC", prompt: "Hosts útiles en /30", config: { answer: 2, tolerance: 0 } });
  const essay = await create({ type: "ESSAY", prompt: "Explica NAT", points: 5, config: { maxWords: 200 } });
  const matching = await create({
    type: "MATCHING",
    prompt: "Relaciona puerto y servicio",
    points: 2,
    options: [
      { text: "22", matchTarget: "SSH" },
      { text: "53", matchTarget: "DNS" },
    ],
  });
  const ordering = await create({
    type: "ORDERING",
    prompt: "Ordena las capas de abajo hacia arriba",
    options: [{ text: "Física" }, { text: "Enlace" }, { text: "Red" }],
  });
  return { bank, single, multiple, trueFalse, short, numeric, essay, matching, ordering };
}

async function createAssessment(courseId: string, items: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  const headers = world.teacher.headers;
  const assessment = json(
    await ctx.app.inject({
      method: "POST",
      url: `/v1/courses/${courseId}/assessments`,
      headers,
      payload: { title: "Examen parcial", maxAttempts: 2, passingScorePercent: 60, revealAnswersPolicy: "AFTER_SUBMISSION", ...overrides },
    }),
  ).data;
  const setItems = await ctx.app.inject({ method: "PUT", url: `/v1/assessments/${assessment.id}/items`, headers, payload: { items } });
  if (setItems.statusCode !== 200) throw new Error(`Items failed ${setItems.body}`);
  const publish = await ctx.app.inject({ method: "POST", url: `/v1/assessments/${assessment.id}/status`, headers, payload: { status: "PUBLISHED" } });
  if (publish.statusCode !== 200) throw new Error(`Publish failed ${publish.body}`);
  return assessment as { id: string };
}

describe("question bank validation", () => {
  it("rejects inconsistent question definitions", async () => {
    const { bank } = await createBankWithQuestions();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/v1/question-banks/${bank.id}/questions`,
      headers: world.teacher.headers,
      payload: { type: "SINGLE_CHOICE", prompt: "Mal", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: true }] },
    });
    expect(response.statusCode).toBe(400);
    const students = await ctx.app.inject({ method: "GET", url: `/v1/question-banks/${bank.id}/questions`, headers: world.student.headers });
    expect(students.statusCode).toBe(404);
  });
});

describe("attempt lifecycle", () => {
  it("grades objective answers on the server and never leaks answer keys", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const q = await createBankWithQuestions();
    const assessment = await createAssessment(
      course.id,
      [q.single, q.multiple, q.trueFalse, q.short, q.numeric, q.matching, q.ordering].map((question) => ({ kind: "FIXED", questionId: question.id })),
      { shuffleOptions: true, shuffleQuestions: true },
    );

    const notEnrolled = await ctx.app.inject({ method: "POST", url: `/v1/assessments/${assessment.id}/attempts`, headers: world.student.headers });
    expect(notEnrolled.statusCode).toBe(403);
    await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers });

    const started = await ctx.app.inject({ method: "POST", url: `/v1/assessments/${assessment.id}/attempts`, headers: world.student.headers });
    expect(started.statusCode).toBe(201);
    expect(started.body).not.toContain("isCorrect");
    expect(started.body).not.toContain("answerKey");
    expect(started.body).not.toContain("acceptedAnswers");
    expect(started.body).not.toContain("SSH\",\"optionId");
    const attempt = json(started).data;
    expect(attempt.questions).toHaveLength(7);

    const byType = Object.fromEntries(attempt.questions.map((question: { type: string }) => [question.type, question]));
    const correctOption = (questionId: string, text: string) => byType[questionId].options.find((option: { text: string }) => option.text === text).id;
    const save = (questionId: string, response: Record<string, unknown>) =>
      ctx.app.inject({ method: "PUT", url: `/v1/attempts/${attempt.id}/answers/${byType[questionId].id}`, headers: world.student.headers, payload: { response } });

    const forged = await save("SINGLE_CHOICE", { optionId: "00000000-0000-7000-8000-000000000000" });
    expect(forged.statusCode).toBe(400);

    expect((await save("SINGLE_CHOICE", { optionId: correctOption("SINGLE_CHOICE", "Red") })).statusCode).toBe(200);
    expect((await save("MULTIPLE_CHOICE", { optionIds: [correctOption("MULTIPLE_CHOICE", "TCP")] })).statusCode).toBe(200);
    expect((await save("TRUE_FALSE", { value: true })).statusCode).toBe(200);
    expect((await save("SHORT_ANSWER", { text: "  arp " })).statusCode).toBe(200);
    expect((await save("NUMERIC", { value: 3 })).statusCode).toBe(200);
    const matchingQuestion = byType["MATCHING"];
    const targetFor = (text: string) => matchingQuestion.targets.find((target: { text: string }) => target.text === text).key;
    const itemFor = (text: string) => matchingQuestion.items.find((item: { text: string }) => item.text === text).id;
    expect((await save("MATCHING", { pairs: { [itemFor("22")]: targetFor("SSH"), [itemFor("53")]: targetFor("DNS") } })).statusCode).toBe(200);
    const orderingQuestion = byType["ORDERING"];
    const order = ["Física", "Enlace", "Red"].map((text) => orderingQuestion.items.find((item: { text: string }) => item.text === text).id);
    expect((await save("ORDERING", { order })).statusCode).toBe(200);

    const submit = await ctx.app.inject({ method: "POST", url: `/v1/attempts/${attempt.id}/submit`, headers: world.student.headers });
    expect(submit.statusCode).toBe(200);
    const result = json(submit).data;
    expect(result.status).toBe("GRADED");
    expect(result.maxPoints).toBe(10);
    expect(result.scorePoints).toBe(8);
    expect(result.scorePercent).toBe(80);
    expect(result.passed).toBe(true);
    const numericResult = result.questions.find((question: { type: string }) => question.type === "NUMERIC");
    expect(numericResult.isCorrect).toBe(false);
    expect(numericResult.correctAnswer.value).toBe(2);

    const afterSubmit = await save("TRUE_FALSE", { value: false });
    expect(afterSubmit.statusCode).toBe(409);
    expect(json(afterSubmit).error.code).toBe("ATTEMPT_CLOSED");

    const peek = await ctx.app.inject({ method: "GET", url: `/v1/attempts/${attempt.id}/result`, headers: world.secondStudent.headers });
    expect(peek.statusCode).toBe(404);
    const review = await ctx.app.inject({ method: "GET", url: `/v1/attempts/${attempt.id}/review`, headers: world.student.headers });
    expect(review.statusCode).toBe(404);

    const stats = json(await ctx.app.inject({ method: "GET", url: `/v1/assessments/${assessment.id}/statistics`, headers: world.teacher.headers })).data;
    expect(stats.gradedAttempts).toBe(1);
    expect(stats.questions).toHaveLength(7);

    const enrollment = await ctx.container.db.enrollment.findFirstOrThrow({ where: { userId: world.student.user.id, courseId: course.id } });
    expect(Number(enrollment.finalScorePercent)).toBe(80);
  });

  it("holds essays for manual grading and completes them when graded", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const q = await createBankWithQuestions();
    const assessment = await createAssessment(course.id, [{ kind: "FIXED", questionId: q.essay.id }, { kind: "FIXED", questionId: q.trueFalse.id }]);
    await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers });
    const attempt = json(await ctx.app.inject({ method: "POST", url: `/v1/assessments/${assessment.id}/attempts`, headers: world.student.headers })).data;
    const essay = attempt.questions.find((question: { type: string }) => question.type === "ESSAY");
    const tf = attempt.questions.find((question: { type: string }) => question.type === "TRUE_FALSE");
    await ctx.app.inject({ method: "PUT", url: `/v1/attempts/${attempt.id}/answers/${essay.id}`, headers: world.student.headers, payload: { response: { text: "NAT traduce direcciones privadas a públicas." } } });
    await ctx.app.inject({ method: "PUT", url: `/v1/attempts/${attempt.id}/answers/${tf.id}`, headers: world.student.headers, payload: { response: { value: true } } });
    const submitted = json(await ctx.app.inject({ method: "POST", url: `/v1/attempts/${attempt.id}/submit`, headers: world.student.headers })).data;
    expect(submitted.status).toBe("PENDING_REVIEW");

    const studentGrades = await ctx.app.inject({ method: "POST", url: `/v1/attempts/${attempt.id}/grades`, headers: world.student.headers, payload: { grades: [{ attemptQuestionId: essay.id, points: 5 }] } });
    expect(studentGrades.statusCode).toBe(404);
    const tooMany = await ctx.app.inject({ method: "POST", url: `/v1/attempts/${attempt.id}/grades`, headers: world.teacher.headers, payload: { grades: [{ attemptQuestionId: essay.id, points: 50 }] } });
    expect(tooMany.statusCode).toBe(400);
    const graded = await ctx.app.inject({
      method: "POST",
      url: `/v1/attempts/${attempt.id}/grades`,
      headers: world.teacher.headers,
      payload: { grades: [{ attemptQuestionId: essay.id, points: 4, feedback: "Bien, falta mencionar PAT" }] },
    });
    expect(graded.statusCode).toBe(200);
    const result = json(await ctx.app.inject({ method: "GET", url: `/v1/attempts/${attempt.id}/result`, headers: world.student.headers })).data;
    expect(result.status).toBe("GRADED");
    expect(result.scorePoints).toBe(5);
    expect(result.questions.find((question: { type: string }) => question.type === "ESSAY").feedback).toContain("PAT");
  });

  it("limits attempts and resumes a single open attempt under concurrency", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const q = await createBankWithQuestions();
    const assessment = await createAssessment(course.id, [{ kind: "POOL", bankId: q.bank.id, drawCount: 3 }], { maxAttempts: 1 });
    await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers });
    const parallel = await Promise.all(Array.from({ length: 5 }, () => ctx.app.inject({ method: "POST", url: `/v1/assessments/${assessment.id}/attempts`, headers: world.student.headers })));
    const ids = new Set(parallel.filter((response) => response.statusCode === 201).map((response) => json(response).data.id));
    expect(ids.size).toBe(1);
    const stored = await ctx.container.db.assessmentAttempt.count({ where: { assessmentId: assessment.id } });
    expect(stored).toBe(1);
    const attemptId = [...ids][0];
    const attempt = json(await ctx.app.inject({ method: "GET", url: `/v1/attempts/${attemptId}`, headers: world.student.headers })).data;
    expect(attempt.questions).toHaveLength(3);
    await ctx.app.inject({ method: "POST", url: `/v1/attempts/${attemptId}/submit`, headers: world.student.headers });
    const again = await ctx.app.inject({ method: "POST", url: `/v1/assessments/${assessment.id}/attempts`, headers: world.student.headers });
    expect(again.statusCode).toBe(409);
    expect(json(again).error.code).toBe("ATTEMPTS_EXHAUSTED");
  });

  it("enforces the time limit on the server and auto-submits through the worker", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const q = await createBankWithQuestions();
    const assessment = await createAssessment(course.id, [{ kind: "FIXED", questionId: q.trueFalse.id }], { timeLimitSeconds: 60, gracePeriodSeconds: 0 });
    await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers });
    const attempt = json(await ctx.app.inject({ method: "POST", url: `/v1/assessments/${assessment.id}/attempts`, headers: world.student.headers })).data;
    await ctx.app.inject({ method: "PUT", url: `/v1/attempts/${attempt.id}/answers/${attempt.questions[0].id}`, headers: world.student.headers, payload: { response: { value: true } } });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000));
    const late = await ctx.app.inject({ method: "PUT", url: `/v1/attempts/${attempt.id}/answers/${attempt.questions[0].id}`, headers: world.student.headers, payload: { response: { value: false } } });
    vi.useRealTimers();
    expect(late.statusCode).toBe(409);
    expect(json(late).error.code).toBe("ATTEMPT_CLOSED");
    const stored = await ctx.container.db.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(stored.status).toBe("GRADED");
    expect(stored.autoSubmitted).toBe(true);
    expect(Number(stored.scorePercent)).toBe(100);
  });

  it("auto-submits abandoned attempts from the outbox when the deadline passes", async () => {
    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const q = await createBankWithQuestions();
    const assessment = await createAssessment(course.id, [{ kind: "FIXED", questionId: q.trueFalse.id }], { timeLimitSeconds: 30, gracePeriodSeconds: 0 });
    await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers });
    const attempt = json(await ctx.app.inject({ method: "POST", url: `/v1/assessments/${assessment.id}/attempts`, headers: world.student.headers })).data;
    await ctx.container.db.outboxEvent.updateMany({ where: { type: "assessment.attempt.autosubmit" }, data: { availableAt: new Date(Date.now() - 1000) } });
    await ctx.container.db.assessmentAttempt.update({ where: { id: attempt.id }, data: { deadlineAt: new Date(Date.now() - 1000) } });
    await ctx.outbox.drain();
    const stored = await ctx.container.db.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(stored.status).toBe("GRADED");
    expect(stored.autoSubmitted).toBe(true);
    expect(Number(stored.scorePercent)).toBe(0);
  });

  it("completes an assessment lesson when the learner passes", async () => {
    const q = await createBankWithQuestions();
    const { course, unitId } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id, {}, [{ title: "Lectura", type: "ARTICLE", body: "Texto" }]);
    const assessment = await createAssessment(course.id, [{ kind: "FIXED", questionId: q.trueFalse.id }]);
    const lesson = await ctx.app.inject({
      method: "POST",
      url: `/v1/units/${unitId}/lessons`,
      headers: world.teacher.headers,
      payload: { title: "Quiz final", type: "ASSESSMENT", assessmentId: assessment.id, status: "PUBLISHED" },
    });
    expect(lesson.statusCode).toBe(201);
    const enrollment = json(await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers })).data;
    const manual = await ctx.app.inject({ method: "POST", url: `/v1/lessons/${json(lesson).data.id}/complete`, headers: world.student.headers });
    expect(manual.statusCode).toBe(409);
    const outline = json(await ctx.app.inject({ method: "GET", url: `/v1/courses/${course.id}/outline`, headers: world.student.headers })).data;
    const reading = outline.modules[0].units[0].lessons.find((item: { type: string }) => item.type === "ARTICLE");
    await ctx.app.inject({ method: "POST", url: `/v1/lessons/${reading.id}/complete`, headers: world.student.headers });
    const attempt = json(await ctx.app.inject({ method: "POST", url: `/v1/assessments/${assessment.id}/attempts`, headers: world.student.headers })).data;
    await ctx.app.inject({ method: "PUT", url: `/v1/attempts/${attempt.id}/answers/${attempt.questions[0].id}`, headers: world.student.headers, payload: { response: { value: true } } });
    await ctx.app.inject({ method: "POST", url: `/v1/attempts/${attempt.id}/submit`, headers: world.student.headers });
    const progress = json(await ctx.app.inject({ method: "GET", url: `/v1/enrollments/${enrollment.id}/progress`, headers: world.student.headers })).data;
    expect(progress.status).toBe("COMPLETED");
    expect(progress.progressPercent).toBe(100);
  });
});
