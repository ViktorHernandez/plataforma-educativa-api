import type { AppInstance } from "../../src/app/types.js";
import { json } from "./test-app.js";

export async function trueFalseAssessment(app: AppInstance, headers: Record<string, string>, institutionId: string, courseId: string, overrides: Record<string, unknown> = {}) {
  const bank = json(await app.inject({ method: "POST", url: `/v1/institutions/${institutionId}/question-banks`, headers, payload: { title: "Banco" } })).data;
  const question = await app.inject({ method: "POST", url: `/v1/question-banks/${bank.id}/questions`, headers, payload: { type: "TRUE_FALSE", prompt: "TCP es orientado a conexión", config: { answer: true } } });
  if (question.statusCode !== 201) throw new Error(`Question failed ${question.body}`);
  const created = await app.inject({
    method: "POST",
    url: `/v1/courses/${courseId}/assessments`,
    headers,
    payload: { title: "Quiz", maxAttempts: 3, passingScorePercent: 60, scoringPolicy: "HIGHEST", ...overrides },
  });
  if (created.statusCode !== 201) throw new Error(`Assessment failed ${created.body}`);
  const assessment = json(created).data as { id: string };
  await app.inject({ method: "PUT", url: `/v1/assessments/${assessment.id}/items`, headers, payload: { items: [{ kind: "FIXED", questionId: json(question).data.id }] } });
  const publish = await app.inject({ method: "POST", url: `/v1/assessments/${assessment.id}/status`, headers, payload: { status: "PUBLISHED" } });
  if (publish.statusCode !== 200) throw new Error(`Publish failed ${publish.body}`);
  return assessment;
}

export async function takeAttempt(app: AppInstance, headers: Record<string, string>, assessmentId: string, answer: boolean | null) {
  const started = await app.inject({ method: "POST", url: `/v1/assessments/${assessmentId}/attempts`, headers });
  if (started.statusCode !== 201) throw new Error(`Attempt failed ${started.statusCode} ${started.body}`);
  const attempt = json(started).data;
  if (answer !== null) {
    await app.inject({ method: "PUT", url: `/v1/attempts/${attempt.id}/answers/${attempt.questions[0].id}`, headers, payload: { response: { value: answer } } });
    await app.inject({ method: "POST", url: `/v1/attempts/${attempt.id}/submit`, headers });
  }
  return attempt as { id: string; deadlineAt: string | null; questions: Array<{ id: string }> };
}
