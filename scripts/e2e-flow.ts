import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config/env.js";
import { createDatabase } from "../src/core/database/prisma.js";
import { DEMO_EMAIL_DOMAIN, registerDemoRecords, resolveDemoTarget } from "../src/scripts/demo-data.js";

const baseUrl = (process.env["E2E_BASE_URL"] ?? process.env["API_BASE_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
const appEnv = process.env["APP_ENV"] ?? "development";

interface Step {
  name: string;
  status: number;
  ok: boolean;
}

const steps: Step[] = [];

async function call(method: string, path: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "x-client-platform": "web", "x-device-id": "e2e-flow-device-000001", ...options.headers };
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

function record(name: string, status: number, expected: number | number[]) {
  const ok = Array.isArray(expected) ? expected.includes(status) : status === expected;
  steps.push({ name, status, ok });
  console.log(`${ok ? "OK  " : "FAIL"} ${String(status).padEnd(4)} ${name}`);
  if (!ok) throw new Error(`Step failed: ${name}`);
}

async function main() {
  console.log(`Running end-to-end flow against ${baseUrl}\n`);
  const health = await call("GET", "/health/ready");
  record("Health check /health/ready", health.status, 200);

  if (appEnv !== "development") throw new Error("Automatic verification is only available with APP_ENV=development. Verify the account with the emailed token instead.");
  const config = loadConfig();
  const target = resolveDemoTarget(config);

  const email = `e2e.${randomBytes(4).toString("hex")}@${DEMO_EMAIL_DOMAIN}`;
  const password = `E2e-${randomBytes(9).toString("base64url")}-9`;
  record("Register user", (await call("POST", "/v1/auth/register", { body: { email, password, displayName: "Usuario E2E", acceptTerms: true, timezone: "America/Mexico_City" } })).status, 202);
  record("Login before verification is refused", (await call("POST", "/v1/auth/login", { body: { email, password } })).status, 403);

  const db = createDatabase({ ...config, DATABASE_POOL_MAX: 1 });
  try {
    const registered = await db.user.update({ where: { email }, data: { status: "ACTIVE", emailVerifiedAt: new Date() } });
    await registerDemoRecords(db, target, { userIds: [registered.id] });
  } finally {
    await db.$disconnect();
  }
  console.log("     (development only) account marked as verified directly in the database");

  const login = await call("POST", "/v1/auth/login", { body: { email, password } });
  record("Login", login.status, 200);
  const token = login.json.data.accessToken as string;
  const refreshToken = login.json.data.refreshToken as string;

  record("Get profile /v1/me", (await call("GET", "/v1/me", { token })).status, 200);
  record("Update preferences", (await call("PATCH", "/v1/me/preferences", { token, body: { locale: "es", accessibility: { reducedMotion: true, textScale: 1.25 } } })).status, 200);
  record("Unauthorized course creation is denied", (await call("POST", `/v1/institutions/${randomUuid()}/courses`, { token, body: { slug: "hack", title: "No permitido" } })).status, [403, 404]);

  const catalog = await call("GET", "/v1/catalog/courses?q=redes");
  record("Browse catalog", catalog.status, 200);
  const course = catalog.json.data[0];
  if (!course) throw new Error("No published course found. Run the development seed first (npm run db:seed).");

  const enroll = await call("POST", `/v1/courses/${course.id}/enrollments`, { token, headers: { "idempotency-key": `e2e-${randomBytes(6).toString("hex")}` } });
  record("Enroll in course", enroll.status, 201);
  const enrollmentId = enroll.json.data.id as string;

  const outline = await call("GET", `/v1/courses/${course.id}/outline`, { token });
  record("Course outline", outline.status, 200);
  const lessons = outline.json.data.modules.flatMap((module: any) => module.units.flatMap((unit: any) => unit.lessons));
  for (const lesson of lessons.filter((item: any) => item.type !== "ASSESSMENT")) {
    record(`Complete lesson "${lesson.title}"`, (await call("POST", `/v1/lessons/${lesson.id}/complete`, { token })).status, 200);
  }

  const assessmentLesson = lessons.find((item: any) => item.type === "ASSESSMENT");
  if (assessmentLesson) {
    const attempt = await call("POST", `/v1/assessments/${assessmentLesson.assessmentId}/attempts`, { token });
    record("Start assessment attempt", attempt.status, 201);
    for (const question of attempt.json.data.questions) {
      const response = answerFor(question);
      if (response) record(`Answer question ${question.position}`, (await call("PUT", `/v1/attempts/${attempt.json.data.id}/answers/${question.id}`, { token, body: { response } })).status, 200);
    }
    const submit = await call("POST", `/v1/attempts/${attempt.json.data.id}/submit`, { token });
    record("Submit attempt and get result", submit.status, 200);
    console.log(`     score: ${submit.json.data.scorePercent}%  passed: ${submit.json.data.passed}`);
  }

  const progress = await call("GET", `/v1/enrollments/${enrollmentId}/progress`, { token });
  record("Read progress", progress.status, 200);
  console.log(`     progress: ${progress.json.data.progressPercent}%  status: ${progress.json.data.status}`);

  await new Promise((resolve) => setTimeout(resolve, 2500));
  const notifications = await call("GET", "/v1/me/notifications", { token });
  record("Notifications generated", notifications.status, 200);
  console.log(`     notifications: ${notifications.json.data.map((item: any) => item.type).join(", ")}`);
  record("Security activity (audit)", (await call("GET", "/v1/auth/activity", { token })).status, 200);

  record("Web push configuration", (await call("GET", "/v1/push/web/config")).status, 200);
  const exportRequest = await call("POST", "/v1/me/privacy/exports", { token, body: { reauth: { password } } });
  record("Request personal data export", exportRequest.status, 202);
  let exportStatus = exportRequest.json.data.status as string;
  let exportUrl: string | null = null;
  for (let attempt = 0; attempt < 30 && exportStatus !== "COMPLETED" && exportStatus !== "FAILED"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const current = await call("GET", `/v1/me/privacy/requests/${exportRequest.json.data.id}`, { token });
    exportStatus = current.json.data.status;
    exportUrl = current.json.data.downloadUrl;
  }
  record("Personal data export generated by the worker", exportStatus === "COMPLETED" ? 200 : 500, 200);
  if (exportUrl) {
    const downloaded = await fetch(exportUrl);
    const body = (await downloaded.json()) as { sections?: { account?: { email?: string } } };
    record("Download personal data export", downloaded.status === 200 && body.sections?.account?.email === email ? 200 : 500, 200);
  }

  const refreshed = await call("POST", "/v1/auth/refresh", { body: { refreshToken } });
  record("Refresh session", refreshed.status, 200);
  const newToken = refreshed.json.data.accessToken as string;
  record("Logout", (await call("POST", "/v1/auth/logout", { token: newToken })).status, 200);
  record("Revoked access token is rejected", (await call("GET", "/v1/me", { token: newToken })).status, 401);
  record("Old refresh token is rejected", (await call("POST", "/v1/auth/refresh", { body: { refreshToken: refreshed.json.data.refreshToken } })).status, 401);
  record("Invalid token is rejected", (await call("GET", "/v1/me", { token: "invalid.token.value" })).status, 401);
  record("Malicious payload is rejected", (await call("POST", "/v1/auth/login", { body: { email: "x@y.co", password: "x", role: "admin" } })).status, 400);

  console.log(`\n${steps.filter((step) => step.ok).length}/${steps.length} steps passed`);
}

function answerFor(question: { type: string; options: Array<{ id: string; text: string }> | null }): Record<string, unknown> | null {
  const choice = question.options?.find((option) => option.text === "Red") ?? question.options?.[0];
  switch (question.type) {
    case "SINGLE_CHOICE":
      return choice ? { optionId: choice.id } : null;
    case "MULTIPLE_CHOICE":
      return choice ? { optionIds: [choice.id] } : null;
    case "TRUE_FALSE":
      return { value: true };
    case "ESSAY":
    case "SHORT_ANSWER":
      return { text: "Respuesta de la verificación de extremo a extremo" };
    default:
      return null;
  }
}

function randomUuid(): string {
  return "00000000-0000-7000-8000-000000000000";
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

