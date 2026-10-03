import { randomBytes, randomInt } from "node:crypto";
import { QuestionType } from "../../generated/prisma/enums.js";
import type { AnswerKey } from "./grading.js";

export interface SourceQuestion {
  id: string;
  version: number;
  type: QuestionType;
  prompt: string;
  explanation: string | null;
  points: number;
  config: Record<string, unknown>;
  options: Array<{ id: string; position: number; text: string; isCorrect: boolean; feedback: string | null; matchTarget: string | null }>;
}

export interface QuestionSnapshot {
  type: QuestionType;
  prompt: string;
  points: number;
  options?: Array<{ id: string; text: string }>;
  items?: Array<{ id: string; text: string }>;
  targets?: Array<{ key: string; text: string }>;
  minWords?: number;
  maxWords?: number;
}

export function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

export function sample<T>(items: T[], count: number): T[] {
  return shuffle(items).slice(0, count);
}

export function buildSnapshot(question: SourceQuestion, options: { shuffleOptions: boolean; points: number }): { snapshot: QuestionSnapshot; answerKey: AnswerKey } {
  const ordered = [...question.options].sort((a, b) => a.position - b.position);
  const base: QuestionSnapshot = { type: question.type, prompt: question.prompt, points: options.points };
  const optionFeedback = Object.fromEntries(ordered.filter((option) => option.feedback).map((option) => [option.id, option.feedback!]));
  const answerKey: AnswerKey = { explanation: question.explanation, optionFeedback };
  const config = question.config;

  switch (question.type) {
    case QuestionType.SINGLE_CHOICE:
    case QuestionType.MULTIPLE_CHOICE: {
      const presented = options.shuffleOptions ? shuffle(ordered) : ordered;
      base.options = presented.map((option) => ({ id: option.id, text: option.text }));
      answerKey.correctOptionIds = ordered.filter((option) => option.isCorrect).map((option) => option.id);
      answerKey.partialCredit = config["partialCredit"] === true;
      break;
    }
    case QuestionType.TRUE_FALSE:
      answerKey.booleanAnswer = config["answer"] === true;
      break;
    case QuestionType.SHORT_ANSWER:
      answerKey.acceptedAnswers = (config["acceptedAnswers"] as string[] | undefined) ?? [];
      answerKey.caseSensitive = config["caseSensitive"] === true;
      answerKey.ignoreAccents = config["ignoreAccents"] !== false;
      break;
    case QuestionType.NUMERIC:
      answerKey.numericAnswer = Number(config["answer"]);
      answerKey.tolerance = Number(config["tolerance"] ?? 0);
      break;
    case QuestionType.ESSAY:
      if (typeof config["minWords"] === "number") base.minWords = config["minWords"];
      if (typeof config["maxWords"] === "number") base.maxWords = config["maxWords"];
      break;
    case QuestionType.MATCHING: {
      const targets = ordered.map((option) => ({ key: randomBytes(6).toString("base64url"), text: option.matchTarget ?? "", optionId: option.id }));
      base.items = (options.shuffleOptions ? shuffle(ordered) : ordered).map((option) => ({ id: option.id, text: option.text }));
      base.targets = shuffle(targets).map((target) => ({ key: target.key, text: target.text }));
      answerKey.matchingPairs = Object.fromEntries(targets.map((target) => [target.optionId, target.key]));
      answerKey.partialCredit = config["partialCredit"] !== false;
      break;
    }
    case QuestionType.ORDERING: {
      let presented = shuffle(ordered);
      if (presented.length > 1 && presented.every((option, index) => option.id === ordered[index]!.id)) presented = [...presented.slice(1), presented[0]!];
      base.items = presented.map((option) => ({ id: option.id, text: option.text }));
      answerKey.orderedOptionIds = ordered.map((option) => option.id);
      break;
    }
  }
  return { snapshot: base, answerKey };
}

export function validateResponseShape(snapshot: QuestionSnapshot, response: Record<string, unknown>): string | null {
  const optionIds = new Set((snapshot.options ?? snapshot.items ?? []).map((option) => option.id));
  switch (snapshot.type) {
    case QuestionType.SINGLE_CHOICE:
      return typeof response["optionId"] === "string" && optionIds.has(response["optionId"]) ? null : "optionId must be one of the presented options";
    case QuestionType.MULTIPLE_CHOICE: {
      const selected = response["optionIds"];
      return Array.isArray(selected) && selected.every((id) => typeof id === "string" && optionIds.has(id)) ? null : "optionIds must reference presented options";
    }
    case QuestionType.TRUE_FALSE:
      return typeof response["value"] === "boolean" ? null : "value must be a boolean";
    case QuestionType.NUMERIC:
      return typeof response["value"] === "number" ? null : "value must be a number";
    case QuestionType.SHORT_ANSWER:
      return typeof response["text"] === "string" && response["text"].length <= 500 ? null : "text must be a short string";
    case QuestionType.ESSAY: {
      const text = response["text"];
      if (typeof text !== "string") return "text is required";
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      if (snapshot.maxWords && words > snapshot.maxWords) return `The answer exceeds ${snapshot.maxWords} words`;
      return null;
    }
    case QuestionType.MATCHING: {
      const pairs = response["pairs"];
      const targetKeys = new Set((snapshot.targets ?? []).map((target) => target.key));
      if (!pairs || typeof pairs !== "object") return "pairs are required";
      return Object.entries(pairs as Record<string, unknown>).every(([optionId, key]) => optionIds.has(optionId) && typeof key === "string" && targetKeys.has(key))
        ? null
        : "pairs must reference presented items and targets";
    }
    case QuestionType.ORDERING: {
      const order = response["order"];
      return Array.isArray(order) && order.length === optionIds.size && new Set(order).size === order.length && order.every((id) => typeof id === "string" && optionIds.has(id))
        ? null
        : "order must contain every presented item once";
    }
    default:
      return "Unsupported question type";
  }
}
