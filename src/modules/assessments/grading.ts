import { QuestionType } from "../../generated/prisma/enums.js";
import type { AnswerResponse } from "./question-types.js";

export interface AnswerKey {
  correctOptionIds?: string[];
  acceptedAnswers?: string[];
  caseSensitive?: boolean;
  ignoreAccents?: boolean;
  numericAnswer?: number;
  tolerance?: number;
  booleanAnswer?: boolean;
  partialCredit?: boolean;
  matchingPairs?: Record<string, string>;
  orderedOptionIds?: string[];
  explanation?: string | null;
  optionFeedback?: Record<string, string>;
}

export interface GradeOutcome {
  mode: "AUTO" | "MANUAL";
  isCorrect: boolean | null;
  awardedPoints: number | null;
}

export function roundPoints(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeText(value: string, key: AnswerKey): string {
  let output = value.trim().replace(/\s+/g, " ");
  if (!key.caseSensitive) output = output.toLocaleLowerCase();
  if (key.ignoreAccents ?? true) output = output.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return output;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((item) => set.has(item));
}

export function gradeResponse(type: QuestionType, key: AnswerKey, response: AnswerResponse | null, points: number): GradeOutcome {
  if (type === QuestionType.ESSAY) return { mode: "MANUAL", isCorrect: null, awardedPoints: null };
  if (!response) return { mode: "AUTO", isCorrect: false, awardedPoints: 0 };
  const full = (correct: boolean): GradeOutcome => ({ mode: "AUTO", isCorrect: correct, awardedPoints: correct ? roundPoints(points) : 0 });

  switch (type) {
    case QuestionType.SINGLE_CHOICE:
      return full(response.optionId !== undefined && (key.correctOptionIds ?? []).includes(response.optionId));
    case QuestionType.TRUE_FALSE:
      return full(typeof response.value === "boolean" && response.value === key.booleanAnswer);
    case QuestionType.NUMERIC:
      return full(typeof response.value === "number" && key.numericAnswer !== undefined && Math.abs(response.value - key.numericAnswer) <= (key.tolerance ?? 0) + 1e-9);
    case QuestionType.SHORT_ANSWER: {
      if (typeof response.text !== "string") return full(false);
      const given = normalizeText(response.text, key);
      return full((key.acceptedAnswers ?? []).some((accepted) => normalizeText(accepted, key) === given));
    }
    case QuestionType.ORDERING: {
      const expected = key.orderedOptionIds ?? [];
      const given = response.order ?? [];
      return full(given.length === expected.length && given.every((id, index) => id === expected[index]));
    }
    case QuestionType.MULTIPLE_CHOICE: {
      const correct = key.correctOptionIds ?? [];
      const selected = [...new Set(response.optionIds ?? [])];
      if (sameSet(correct, selected)) return full(true);
      if (!key.partialCredit || correct.length === 0) return full(false);
      const hits = selected.filter((id) => correct.includes(id)).length;
      const misses = selected.length - hits;
      const ratio = Math.max(0, (hits - misses) / correct.length);
      return { mode: "AUTO", isCorrect: false, awardedPoints: roundPoints(points * ratio) };
    }
    case QuestionType.MATCHING: {
      const pairs = key.matchingPairs ?? {};
      const entries = Object.entries(pairs);
      if (entries.length === 0) return full(false);
      const given = response.pairs ?? {};
      const hits = entries.filter(([optionId, target]) => given[optionId] === target).length;
      if (hits === entries.length) return full(true);
      if (key.partialCredit === false) return full(false);
      return { mode: "AUTO", isCorrect: false, awardedPoints: roundPoints((points * hits) / entries.length) };
    }
    default:
      return { mode: "MANUAL", isCorrect: null, awardedPoints: null };
  }
}

export function aggregateScore(policy: "HIGHEST" | "LATEST" | "AVERAGE" | "FIRST", graded: Array<{ scorePercent: number; submittedAt: Date }>): number | null {
  if (graded.length === 0) return null;
  const ordered = [...graded].sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
  switch (policy) {
    case "LATEST":
      return ordered[ordered.length - 1]!.scorePercent;
    case "FIRST":
      return ordered[0]!.scorePercent;
    case "AVERAGE":
      return roundPoints(ordered.reduce((sum, item) => sum + item.scorePercent, 0) / ordered.length);
    default:
      return Math.max(...ordered.map((item) => item.scorePercent));
  }
}
