import { describe, expect, it } from "vitest";
import { QuestionType } from "../../src/generated/prisma/enums.js";
import { buildSnapshot, validateResponseShape } from "../../src/modules/assessments/attempt-builder.js";
import { aggregateScore, gradeResponse } from "../../src/modules/assessments/grading.js";
import { validateQuestionDefinition } from "../../src/modules/assessments/question-types.js";

describe("gradeResponse", () => {
  it("grades single choice", () => {
    expect(gradeResponse(QuestionType.SINGLE_CHOICE, { correctOptionIds: ["a"] }, { optionId: "a" }, 2)).toEqual({ mode: "AUTO", isCorrect: true, awardedPoints: 2 });
    expect(gradeResponse(QuestionType.SINGLE_CHOICE, { correctOptionIds: ["a"] }, { optionId: "b" }, 2).awardedPoints).toBe(0);
  });

  it("applies partial credit with penalties for wrong selections", () => {
    const key = { correctOptionIds: ["a", "b"], partialCredit: true };
    expect(gradeResponse(QuestionType.MULTIPLE_CHOICE, key, { optionIds: ["a"] }, 2).awardedPoints).toBe(1);
    expect(gradeResponse(QuestionType.MULTIPLE_CHOICE, key, { optionIds: ["a", "c"] }, 2).awardedPoints).toBe(0);
    expect(gradeResponse(QuestionType.MULTIPLE_CHOICE, key, { optionIds: ["b", "a"] }, 2).isCorrect).toBe(true);
    expect(gradeResponse(QuestionType.MULTIPLE_CHOICE, { correctOptionIds: ["a", "b"] }, { optionIds: ["a"] }, 2).awardedPoints).toBe(0);
  });

  it("normalizes short answers", () => {
    const key = { acceptedAnswers: ["Protocolo ARP"], caseSensitive: false, ignoreAccents: true };
    expect(gradeResponse(QuestionType.SHORT_ANSWER, key, { text: "  protocolo   árp " }, 1).isCorrect).toBe(true);
    expect(gradeResponse(QuestionType.SHORT_ANSWER, { ...key, caseSensitive: true }, { text: "protocolo arp" }, 1).isCorrect).toBe(false);
  });

  it("respects numeric tolerance", () => {
    expect(gradeResponse(QuestionType.NUMERIC, { numericAnswer: 3.14, tolerance: 0.01 }, { value: 3.15 }, 1).isCorrect).toBe(true);
    expect(gradeResponse(QuestionType.NUMERIC, { numericAnswer: 3.14, tolerance: 0.01 }, { value: 3.2 }, 1).isCorrect).toBe(false);
  });

  it("grades matching with partial credit and ordering strictly", () => {
    const key = { matchingPairs: { a: "x", b: "y" }, partialCredit: true };
    expect(gradeResponse(QuestionType.MATCHING, key, { pairs: { a: "x", b: "x" } }, 2).awardedPoints).toBe(1);
    expect(gradeResponse(QuestionType.ORDERING, { orderedOptionIds: ["a", "b", "c"] }, { order: ["a", "c", "b"] }, 1).isCorrect).toBe(false);
  });

  it("sends essays to manual grading and scores missing answers as zero", () => {
    expect(gradeResponse(QuestionType.ESSAY, {}, { text: "x" }, 5).mode).toBe("MANUAL");
    expect(gradeResponse(QuestionType.TRUE_FALSE, { booleanAnswer: true }, null, 1).awardedPoints).toBe(0);
  });
});

describe("aggregateScore", () => {
  const attempts = [
    { scorePercent: 50, submittedAt: new Date("2026-01-01") },
    { scorePercent: 90, submittedAt: new Date("2026-01-02") },
    { scorePercent: 70, submittedAt: new Date("2026-01-03") },
  ];
  it("supports every scoring policy", () => {
    expect(aggregateScore("HIGHEST", attempts)).toBe(90);
    expect(aggregateScore("LATEST", attempts)).toBe(70);
    expect(aggregateScore("FIRST", attempts)).toBe(50);
    expect(aggregateScore("AVERAGE", attempts)).toBe(70);
    expect(aggregateScore("HIGHEST", [])).toBeNull();
  });
});

describe("attempt snapshots", () => {
  const question = {
    id: "q1",
    version: 1,
    type: QuestionType.SINGLE_CHOICE,
    prompt: "?",
    explanation: "porque",
    points: 1,
    config: {},
    options: [
      { id: "o1", position: 1, text: "A", isCorrect: false, feedback: null, matchTarget: null },
      { id: "o2", position: 2, text: "B", isCorrect: true, feedback: "bien", matchTarget: null },
    ],
  };

  it("keeps correctness only inside the answer key", () => {
    const { snapshot, answerKey } = buildSnapshot(question, { shuffleOptions: true, points: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("isCorrect");
    expect(JSON.stringify(snapshot)).not.toContain("bien");
    expect(answerKey.correctOptionIds).toEqual(["o2"]);
  });

  it("never presents ordering items already sorted", () => {
    for (let run = 0; run < 20; run += 1) {
      const { snapshot } = buildSnapshot(
        { ...question, type: QuestionType.ORDERING, options: question.options.map((option) => ({ ...option, isCorrect: false })) },
        { shuffleOptions: false, points: 1 },
      );
      expect(snapshot.items!.map((item) => item.id)).not.toEqual(["o1", "o2"]);
    }
  });

  it("validates response shapes against presented options", () => {
    const { snapshot } = buildSnapshot(question, { shuffleOptions: false, points: 1 });
    expect(validateResponseShape(snapshot, { optionId: "o1" })).toBeNull();
    expect(validateResponseShape(snapshot, { optionId: "forged" })).not.toBeNull();
  });
});

describe("question definitions", () => {
  it("validates type specific rules", () => {
    expect(validateQuestionDefinition(QuestionType.SINGLE_CHOICE, {}, [{ text: "a", isCorrect: true }]).issues).not.toHaveLength(0);
    expect(validateQuestionDefinition(QuestionType.NUMERIC, { answer: 2 }, []).issues).toHaveLength(0);
    expect(validateQuestionDefinition(QuestionType.SHORT_ANSWER, { acceptedAnswers: [] }, []).issues).not.toHaveLength(0);
    expect(validateQuestionDefinition(QuestionType.MATCHING, {}, [{ text: "a", isCorrect: false }, { text: "b", isCorrect: false }]).issues).not.toHaveLength(0);
  });
});
