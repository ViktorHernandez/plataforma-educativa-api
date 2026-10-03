import { z } from "zod";
import { QuestionType } from "../../generated/prisma/enums.js";

export const optionInput = z
  .object({
    text: z.string().trim().min(1).max(2000),
    isCorrect: z.boolean().default(false),
    feedback: z.string().trim().max(1000).nullable().optional(),
    matchTarget: z.string().trim().min(1).max(1000).nullable().optional(),
  })
  .strict();

export type OptionInput = z.infer<typeof optionInput>;

export const shortAnswerConfig = z
  .object({
    acceptedAnswers: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    caseSensitive: z.boolean().default(false),
    ignoreAccents: z.boolean().default(true),
  })
  .strict();

export const numericConfig = z.object({ answer: z.number().finite(), tolerance: z.number().min(0).default(0) }).strict();
export const trueFalseConfig = z.object({ answer: z.boolean() }).strict();
export const multipleChoiceConfig = z.object({ partialCredit: z.boolean().default(false) }).strict();
export const essayConfig = z
  .object({ rubric: z.string().max(10_000).nullable().optional(), minWords: z.number().int().min(0).optional(), maxWords: z.number().int().min(1).max(20_000).optional() })
  .strict();
export const emptyConfig = z.object({}).strict();
export const matchingConfig = z.object({ partialCredit: z.boolean().default(true) }).strict();

export const configSchemas: Record<QuestionType, z.ZodType> = {
  SINGLE_CHOICE: emptyConfig,
  MULTIPLE_CHOICE: multipleChoiceConfig,
  TRUE_FALSE: trueFalseConfig,
  SHORT_ANSWER: shortAnswerConfig,
  NUMERIC: numericConfig,
  ESSAY: essayConfig,
  MATCHING: matchingConfig,
  ORDERING: emptyConfig,
};

export interface QuestionDefinitionIssue {
  path: string;
  message: string;
}

export function validateQuestionDefinition(type: QuestionType, config: unknown, options: OptionInput[]): { config: Record<string, unknown>; issues: QuestionDefinitionIssue[] } {
  const issues: QuestionDefinitionIssue[] = [];
  const parsed = configSchemas[type].safeParse(config ?? {});
  if (!parsed.success) {
    for (const issue of parsed.error.issues) issues.push({ path: `config.${issue.path.join(".")}`, message: issue.message });
  }
  const correct = options.filter((option) => option.isCorrect).length;
  switch (type) {
    case QuestionType.SINGLE_CHOICE:
      if (options.length < 2) issues.push({ path: "options", message: "At least two options are required" });
      if (correct !== 1) issues.push({ path: "options", message: "Exactly one option must be correct" });
      break;
    case QuestionType.MULTIPLE_CHOICE:
      if (options.length < 2) issues.push({ path: "options", message: "At least two options are required" });
      if (correct < 1) issues.push({ path: "options", message: "At least one option must be correct" });
      break;
    case QuestionType.MATCHING:
      if (options.length < 2) issues.push({ path: "options", message: "At least two pairs are required" });
      if (options.some((option) => !option.matchTarget)) issues.push({ path: "options", message: "Every option needs a matchTarget" });
      break;
    case QuestionType.ORDERING:
      if (options.length < 2) issues.push({ path: "options", message: "At least two items are required" });
      break;
    default:
      if (options.length > 0) issues.push({ path: "options", message: "This question type does not use options" });
  }
  return { config: parsed.success ? (parsed.data as Record<string, unknown>) : {}, issues };
}

export const answerResponse = z
  .object({
    optionId: z.uuid().optional(),
    optionIds: z.array(z.uuid()).max(50).optional(),
    value: z.union([z.boolean(), z.number().finite()]).optional(),
    text: z.string().max(50_000).optional(),
    pairs: z.record(z.uuid(), z.string().max(64)).optional(),
    order: z.array(z.uuid()).max(50).optional(),
  })
  .strict();

export type AnswerResponse = z.infer<typeof answerResponse>;
