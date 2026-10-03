import { randomBytes } from "node:crypto";
import { demoAccounts, DEMO_EXTERNAL_INSTITUTION_SLUG, DEMO_INSTITUTION_SLUG, type DemoAccountKey } from "../src/scripts/demo-data.js";

const baseUrl = (process.env["API_BASE_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
const password = process.env["DEMO_PASSWORD"] ?? "Demo-Local-Solo-2026!";

interface Result {
  status: number;
  json: any;
  headers: Headers;
  text: string;
}

interface Outcome {
  name: string;
  method: string;
  status: number;
  expected: number[];
  ok: boolean;
}

const outcomes: Outcome[] = [];
const tokens = {} as Record<DemoAccountKey, string>;

async function call(method: string, path: string, options: { as?: DemoAccountKey; body?: unknown; headers?: Record<string, string>; raw?: Buffer } = {}): Promise<Result> {
  const headers: Record<string, string> = { "x-client-platform": "web", "accept-language": "es", ...options.headers };
  if (options.as) headers["authorization"] = `Bearer ${tokens[options.as]}`;
  let body: Uint8Array | string | undefined;
  if (options.raw) body = new Uint8Array(options.raw);
  else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body, redirect: "manual" });
  const text = await response.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, headers: response.headers, text };
}

function expectStatus(name: string, method: string, result: Result, expected: number | number[]): Result {
  const accepted = Array.isArray(expected) ? expected : [expected];
  const ok = accepted.includes(result.status);
  outcomes.push({ name, method, status: result.status, expected: accepted, ok });
  const detail = ok ? "" : ` -> ${result.text.slice(0, 200)}`;
  console.log(`${ok ? "OK  " : "FAIL"} ${method.padEnd(6)} ${String(result.status).padEnd(4)} ${name}${detail}`);
  return result;
}

function expectTrue(name: string, condition: boolean) {
  outcomes.push({ name, method: "CHECK", status: condition ? 1 : 0, expected: [1], ok: condition });
  console.log(`${condition ? "OK  " : "FAIL"} CHECK       ${name}`);
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    outcomes.push({ name, method: "STEP", status: 0, expected: [1], ok: false });
    console.log(`FAIL STEP        ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function main() {
  console.log(`API role and isolation check against ${baseUrl}\n`);
  expectStatus("Liveness", "GET", await call("GET", "/health/live"), 200);
  expectStatus("Readiness", "GET", await call("GET", "/health/ready"), 200);
  expectStatus("Metrics require a token", "GET", await call("GET", "/metrics"), [401, 404]);

  expectStatus("Login with a wrong password is rejected", "POST", await call("POST", "/v1/auth/login", { body: { email: demoAccounts.student.email, password: "Wrong-Password-123" } }), 401);
  expectStatus("Unknown fields are rejected", "POST", await call("POST", "/v1/auth/login", { body: { email: demoAccounts.student.email, password, role: "admin" } }), 400);
  for (const key of Object.keys(demoAccounts) as DemoAccountKey[]) {
    const login = expectStatus(`Login ${key}`, "POST", await call("POST", "/v1/auth/login", { body: { email: demoAccounts[key].email, password } }), 200);
    if (login.status !== 200) throw new Error(`Cannot continue without ${key}. Run npm run demo:seed first.`);
    tokens[key] = login.json.data.accessToken;
  }

  expectStatus("Profile without token", "GET", await call("GET", "/v1/me"), 401);
  expectStatus("Profile of the student", "GET", await call("GET", "/v1/me", { as: "student" }), 200);
  expectStatus("Update own preferences", "PATCH", await call("PATCH", "/v1/me/preferences", { as: "student", body: { locale: "es", timezone: "America/Mexico_City" } }), 200);
  expectStatus("Own permissions", "GET", await call("GET", "/v1/me/permissions", { as: "teacher" }), 200);

  const institutions = expectStatus("Institutions of the institution admin", "GET", await call("GET", "/v1/institutions", { as: "institutionAdmin" }), 200);
  const demoInstitution = institutions.json.data.find((item: { slug: string }) => item.slug === DEMO_INSTITUTION_SLUG);
  const external = expectStatus("Institutions of the external admin", "GET", await call("GET", "/v1/institutions", { as: "externalAdmin" }), 200);
  const externalInstitution = external.json.data.find((item: { slug: string }) => item.slug === DEMO_EXTERNAL_INSTITUTION_SLUG);
  expectTrue("Each admin only sees its own institution", Boolean(demoInstitution) && Boolean(externalInstitution) && !external.json.data.some((item: { slug: string }) => item.slug === DEMO_INSTITUTION_SLUG));
  const institutionId = demoInstitution.id as string;

  expectStatus("Members listed by the institution admin", "GET", await call("GET", `/v1/institutions/${institutionId}/members`, { as: "institutionAdmin" }), 200);
  expectStatus("Members hidden from another institution", "GET", await call("GET", `/v1/institutions/${institutionId}/members`, { as: "externalAdmin" }), [403, 404]);
  expectStatus("Members hidden from students", "GET", await call("GET", `/v1/institutions/${institutionId}/members`, { as: "student" }), [403, 404]);
  expectStatus("Institution report for its admin", "GET", await call("GET", `/v1/institutions/${institutionId}/reports/overview`, { as: "institutionAdmin" }), 200);
  expectStatus("Institution report denied to students", "GET", await call("GET", `/v1/institutions/${institutionId}/reports/overview`, { as: "student" }), [403, 404]);
  expectStatus("Platform users denied to institution admins", "GET", await call("GET", "/v1/admin/users", { as: "institutionAdmin" }), 403);
  expectStatus("Platform users for the platform admin", "GET", await call("GET", "/v1/admin/users?search=demo", { as: "platformAdmin" }), 200);
  expectStatus("Audit log for the platform admin", "GET", await call("GET", "/v1/admin/audit-logs", { as: "platformAdmin" }), 200);

  const staffCourses = expectStatus("Courses of the institution for the teacher", "GET", await call("GET", `/v1/institutions/${institutionId}/courses?pageSize=50`, { as: "teacher" }), 200);
  const bySlug = (slug: string) => staffCourses.json.data.find((course: { slug: string }) => course.slug === slug);
  const networking = bySlug("demo-fundamentos-de-redes");
  const programming = bySlug("demo-introduccion-a-la-programacion");
  const draft = bySlug("demo-seguridad-avanzada");
  expectTrue("Demo courses exist", Boolean(networking && programming && draft));

  const anonymousCatalog = expectStatus("Public catalog without session", "GET", await call("GET", "/v1/catalog/courses?q=demo"), 200);
  const anonymousIds = anonymousCatalog.json.data.map((course: { id: string }) => course.id);
  expectTrue("Catalog shows the public course and hides institution-only and draft courses", anonymousIds.includes(networking.id) && !anonymousIds.includes(programming.id) && !anonymousIds.includes(draft.id));
  expectStatus("Institution-only course for a member", "GET", await call("GET", `/v1/catalog/courses/${programming.id}`, { as: "student" }), 200);
  expectStatus("Institution-only course hidden from outsiders", "GET", await call("GET", `/v1/catalog/courses/${programming.id}`, { as: "externalAdmin" }), 404);
  expectStatus("Draft course hidden from students", "GET", await call("GET", `/v1/catalog/courses/${draft.id}`, { as: "student" }), 404);
  expectStatus("Draft course visible to its teacher", "GET", await call("GET", `/v1/courses/${draft.id}`, { as: "teacher" }), 200);

  const slug = `api-check-${randomBytes(3).toString("hex")}`;
  expectStatus("Students cannot create courses", "POST", await call("POST", `/v1/institutions/${institutionId}/courses`, { as: "student", body: { slug, title: "No permitido" } }), [403, 404]);
  expectStatus("Other institutions cannot create courses here", "POST", await call("POST", `/v1/institutions/${institutionId}/courses`, { as: "externalAdmin", body: { slug, title: "No permitido" } }), [403, 404]);
  expectStatus("Invalid course payload", "POST", await call("POST", `/v1/institutions/${institutionId}/courses`, { as: "teacher", body: { slug: "Invalid Slug", title: "x" } }), 400);
  const created = expectStatus("Teacher creates a course", "POST", await call("POST", `/v1/institutions/${institutionId}/courses`, { as: "teacher", body: { slug, title: "Curso creado por la verificación de API" } }), 201);
  const courseId = created.json.data.id as string;
  const updated = expectStatus("Teacher updates the course with If-Match", "PATCH", await call("PATCH", `/v1/courses/${courseId}`, { as: "teacher", body: { summary: "Resumen actualizado" }, headers: { "if-match": `"${created.json.data.version}"` } }), 200);
  expectStatus("Stale version is rejected", "PATCH", await call("PATCH", `/v1/courses/${courseId}`, { as: "teacher", body: { summary: "Otro" }, headers: { "if-match": `"${created.json.data.version}"` } }), 409);
  expectStatus("Outsider cannot update the course", "PATCH", await call("PATCH", `/v1/courses/${courseId}`, { as: "externalAdmin", body: { summary: "Hack" }, headers: { "if-match": `"${updated.json.data.version}"` } }), [403, 404]);
  const module = expectStatus("Create module", "POST", await call("POST", `/v1/courses/${courseId}/modules`, { as: "teacher", body: { title: "Módulo de prueba" } }), 201);
  const unit = expectStatus("Create unit", "POST", await call("POST", `/v1/modules/${module.json.data.id}/units`, { as: "teacher", body: { title: "Unidad de prueba" } }), 201);
  const lesson = expectStatus("Create lesson", "POST", await call("POST", `/v1/units/${unit.json.data.id}/lessons`, { as: "teacher", body: { title: "Lección", type: "ARTICLE", status: "PUBLISHED", body: "Contenido" } }), 201);
  const extra = expectStatus("Create a second lesson", "POST", await call("POST", `/v1/units/${unit.json.data.id}/lessons`, { as: "teacher", body: { title: "Lección temporal", type: "ARTICLE", status: "PUBLISHED", body: "Temporal" } }), 201);
  expectStatus("Script injection in content is rejected", "POST", await call("POST", `/v1/units/${unit.json.data.id}/lessons`, { as: "teacher", body: { title: "XSS", type: "ARTICLE", body: "<script>alert(1)</script>" } }), 400);
  expectStatus("Students cannot delete lessons", "DELETE", await call("DELETE", `/v1/lessons/${extra.json.data.id}`, { as: "student" }), [403, 404]);
  expectStatus("Teacher deletes a lesson", "DELETE", await call("DELETE", `/v1/lessons/${extra.json.data.id}`, { as: "teacher" }), 200);
  expectStatus("Publish course", "POST", await call("POST", `/v1/courses/${courseId}/status`, { as: "teacher", body: { status: "PUBLISHED" } }), 200);

  const enrollment = expectStatus("Enroll in the new course", "POST", await call("POST", `/v1/courses/${courseId}/enrollments`, { as: "secondStudent", headers: { "idempotency-key": `api-check-${slug}` } }), 201);
  expectStatus("Idempotent retry returns the same enrollment", "POST", await call("POST", `/v1/courses/${courseId}/enrollments`, { as: "secondStudent", headers: { "idempotency-key": `api-check-${slug}` } }), 201);
  expectStatus("Duplicate enrollment is rejected", "POST", await call("POST", `/v1/courses/${courseId}/enrollments`, { as: "secondStudent" }), 409);
  expectStatus("Own enrollments", "GET", await call("GET", "/v1/me/enrollments", { as: "secondStudent" }), 200);
  expectStatus("Enrollment of another learner is hidden", "GET", await call("GET", `/v1/enrollments/${enrollment.json.data.id}`, { as: "student" }), 404);
  expectStatus("Teacher lists course enrollments", "GET", await call("GET", `/v1/courses/${courseId}/enrollments`, { as: "teacher" }), 200);
  expectStatus("Students cannot list course enrollments", "GET", await call("GET", `/v1/courses/${courseId}/enrollments`, { as: "student" }), [403, 404]);
  expectStatus("Complete a lesson", "POST", await call("POST", `/v1/lessons/${lesson.json.data.id}/complete`, { as: "secondStudent" }), 200);
  const progress = expectStatus("Enrollment progress", "GET", await call("GET", `/v1/enrollments/${enrollment.json.data.id}/progress`, { as: "secondStudent" }), 200);
  expectTrue("Progress reached 100%", progress.json.data.enrollment?.progressPercent === 100 || progress.json.data.progressPercent === 100);
  expectStatus("Completed enrollments cannot be cancelled", "POST", await call("POST", `/v1/enrollments/${enrollment.json.data.id}/cancel`, { as: "secondStudent", body: {} }), 409);
  const second = expectStatus("Another learner enrolls", "POST", await call("POST", `/v1/courses/${courseId}/enrollments`, { as: "student" }), 201);
  expectStatus("Learners cannot cancel enrollments of others", "POST", await call("POST", `/v1/enrollments/${second.json.data.id}/cancel`, { as: "secondStudent", body: {} }), 404);
  expectStatus("Cancel own enrollment", "POST", await call("POST", `/v1/enrollments/${second.json.data.id}/cancel`, { as: "student", body: {} }), 200);

  await step("Assessment flow", async () => {
    const assessments = expectStatus("Assessments of the networking course", "GET", await call("GET", `/v1/courses/${networking.id}/assessments`, { as: "teacher" }), 200);
    const assessmentId = assessments.json.data[0].id as string;
    const learnerView = expectStatus("Assessment overview for the learner", "GET", await call("GET", `/v1/assessments/${assessmentId}`, { as: "secondStudent" }), 200);
    let attemptId = learnerView.json.data.inProgressAttemptId as string | null;
    if (!attemptId) {
      if (learnerView.json.data.attemptsRemaining === 0) throw new Error("The demo learner has no attempts left. Run npm run demo:reset and try again.");
      const started = expectStatus("Start a new attempt", "POST", await call("POST", `/v1/assessments/${assessmentId}/attempts`, { as: "secondStudent" }), 201);
      attemptId = started.json.data.id as string;
    }
    expectTrue("An attempt is in progress", Boolean(attemptId));
    const attempt = expectStatus("Open attempt", "GET", await call("GET", `/v1/attempts/${attemptId}`, { as: "secondStudent" }), 200);
    expectTrue("Answer keys are not exposed while the attempt is open", !/isCorrect|answerKey|correctOptionIds/.test(attempt.text));
    expectStatus("Attempt of another learner is hidden", "GET", await call("GET", `/v1/attempts/${attemptId}`, { as: "student" }), 404);
    const question = attempt.json.data.questions.find((item: { type: string }) => item.type === "TRUE_FALSE");
    expectStatus("Save an answer", "PUT", await call("PUT", `/v1/attempts/${attemptId}/answers/${question.id}`, { as: "secondStudent", body: { response: { value: true } } }), 200);
    expectStatus("Malformed answer is rejected", "PUT", await call("PUT", `/v1/attempts/${attemptId}/answers/${question.id}`, { as: "secondStudent", body: { response: { value: "yes" } } }), 400);
    expectStatus("Submit attempt", "POST", await call("POST", `/v1/attempts/${attemptId}/submit`, { as: "secondStudent" }), 200);
    expectStatus("Answers are frozen after submission", "PUT", await call("PUT", `/v1/attempts/${attemptId}/answers/${question.id}`, { as: "secondStudent", body: { response: { value: false } } }), 409);
    expectStatus("Learners cannot list every attempt", "GET", await call("GET", `/v1/assessments/${assessmentId}/attempts`, { as: "student" }), [403, 404]);
    expectStatus("Teacher lists attempts", "GET", await call("GET", `/v1/assessments/${assessmentId}/attempts`, { as: "teacher" }), 200);

    const essayAssessments = expectStatus("Assessments of the programming course", "GET", await call("GET", `/v1/courses/${programming.id}/assessments`, { as: "teacher" }), 200);
    const essayAssessmentId = essayAssessments.json.data[0].id as string;
    const pending = expectStatus("Attempts pending review", "GET", await call("GET", `/v1/assessments/${essayAssessmentId}/attempts?status=PENDING_REVIEW`, { as: "teacher" }), 200);
    const pendingAttempt = pending.json.data[0];
    if (pendingAttempt) {
      const review = expectStatus("Teacher reviews the attempt", "GET", await call("GET", `/v1/attempts/${pendingAttempt.id}/review`, { as: "teacher" }), 200);
      const essay = review.json.data.questions.find((item: { type: string }) => item.type === "ESSAY");
      expectStatus("Students cannot grade", "POST", await call("POST", `/v1/attempts/${pendingAttempt.id}/grades`, { as: "student", body: { grades: [{ attemptQuestionId: essay.id, points: 1 }] } }), [403, 404]);
      expectStatus("Points above the question value are rejected", "POST", await call("POST", `/v1/attempts/${pendingAttempt.id}/grades`, { as: "teacher", body: { grades: [{ attemptQuestionId: essay.id, points: 999 }] } }), 400);
      const graded = expectStatus("Teacher grades the essay", "POST", await call("POST", `/v1/attempts/${pendingAttempt.id}/grades`, { as: "teacher", body: { grades: [{ attemptQuestionId: essay.id, points: essay.points, feedback: "Buen trabajo" }] } }), 200);
      expectTrue("The attempt is graded", graded.json.data.status === "GRADED");
    } else {
      console.log("SKIP CHECK       Manual grading: no attempt is pending review. Run npm run demo:reset to recreate it.");
    }
  });

  const certificates = expectStatus("Own certificates", "GET", await call("GET", "/v1/me/certificates", { as: "student" }), 200);
  const certificate = certificates.json.data[0];
  expectTrue("The completed course issued a certificate", Boolean(certificate));
  if (certificate) {
    expectStatus("Public certificate verification", "GET", await call("GET", `/v1/certificates/verify/${certificate.verificationCode}`), 200);
    expectStatus("Students cannot revoke certificates", "POST", await call("POST", `/v1/certificates/${certificate.id}/revoke`, { as: "student", body: { reason: "Sin motivo" } }), [403, 404]);
  }

  await step("Files", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d5b1a40000000049454e44ae426082", "hex");
    expectStatus("SVG uploads are refused", "POST", await call("POST", "/v1/files/uploads", { as: "student", body: { purpose: "AVATAR", fileName: "a.svg", mimeType: "image/svg+xml", sizeBytes: 100 } }), 400);
    const intent = expectStatus("Request an upload", "POST", await call("POST", "/v1/files/uploads", { as: "student", body: { purpose: "AVATAR", fileName: "avatar.png", mimeType: "image/png", sizeBytes: png.length } }), 201);
    const upload = intent.json.data.upload as { method: string; url: string; headers: Record<string, string> };
    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: new Uint8Array(png) });
    expectTrue(`Upload the bytes (${put.status})`, put.status === 204 || put.status === 200);
    const fileId = intent.json.data.file.id as string;
    const completed = expectStatus("Complete the upload", "POST", await call("POST", `/v1/files/${fileId}/complete`, { as: "student" }), 200);
    expectTrue("File is ready or waiting for the antivirus", ["READY", "PROCESSING"].includes(completed.json.data.status));
    expectStatus("File metadata for the owner", "GET", await call("GET", `/v1/files/${fileId}`, { as: "student" }), 200);
    expectStatus("Non owners cannot delete the file", "DELETE", await call("DELETE", `/v1/files/${fileId}`, { as: "teacher" }), 404);
    expectStatus("Owner deletes the file", "DELETE", await call("DELETE", `/v1/files/${fileId}`, { as: "student" }), 200);
  });

  await step("Messaging", async () => {
    const teacherId = (await call("GET", "/v1/me", { as: "teacher" })).json.data.id as string;
    const conversation = expectStatus("Open a direct conversation", "POST", await call("POST", "/v1/conversations/direct", { as: "student", body: { userId: teacherId } }), 200);
    const conversationId = conversation.json.data.id as string;
    const message = expectStatus("Send a message", "POST", await call("POST", `/v1/conversations/${conversationId}/messages`, { as: "student", body: { body: "Hola, ¿cuándo es el examen?" } }), 201);
    expectStatus("Recipient reads the conversation", "GET", await call("GET", `/v1/conversations/${conversationId}/messages`, { as: "teacher" }), 200);
    expectStatus("Outsiders cannot read the conversation", "GET", await call("GET", `/v1/conversations/${conversationId}/messages`, { as: "externalAdmin" }), 404);
    expectStatus("Only the author edits a message", "PATCH", await call("PATCH", `/v1/messages/${message.json.data.id}`, { as: "teacher", body: { body: "Editado" } }), 403);
    expectStatus("Author edits the message", "PATCH", await call("PATCH", `/v1/messages/${message.json.data.id}`, { as: "student", body: { body: "Hola, ¿cuándo es el examen final?" } }), 200);
    expectStatus("Author deletes the message", "DELETE", await call("DELETE", `/v1/messages/${message.json.data.id}`, { as: "student" }), 200);
    expectStatus("Conversation list", "GET", await call("GET", "/v1/conversations", { as: "teacher" }), 200);
  });

  await step("Reports", async () => {
    const requested = expectStatus("Teacher requests an enrollment export", "POST", await call("POST", "/v1/reports/exports", { as: "teacher", body: { type: "course.enrollments", courseId: networking.id } }), 202);
    expectStatus("Other users cannot see the export", "GET", await call("GET", `/v1/reports/exports/${requested.json.data.id}`, { as: "student" }), 404);
    expectStatus("Requester sees the export", "GET", await call("GET", `/v1/reports/exports/${requested.json.data.id}`, { as: "teacher" }), 200);
  });

  expectStatus("Notifications", "GET", await call("GET", "/v1/me/notifications", { as: "student" }), 200);
  expectStatus("Privacy requests", "GET", await call("GET", "/v1/me/privacy/requests", { as: "student" }), 200);
  expectStatus("Sessions", "GET", await call("GET", "/v1/auth/sessions", { as: "student" }), 200);
  expectStatus("Logout", "POST", await call("POST", "/v1/auth/logout", { as: "externalAdmin" }), 200);
  expectStatus("Revoked token is rejected", "GET", await call("GET", "/v1/me", { as: "externalAdmin" }), 401);

  const failed = outcomes.filter((outcome) => !outcome.ok);
  console.log(`\n${outcomes.length - failed.length}/${outcomes.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
