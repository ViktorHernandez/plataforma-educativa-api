import { describe, expect, it } from "vitest";
import { personalDataStream, type ExportCounter } from "../../src/modules/privacy/personal-data-export.js";
import { ReportService } from "../../src/modules/reports/report.service.js";

function fakeRows(total: number, calls: number[]) {
  return (cursor: string | undefined, take: number) => {
    calls.push(take);
    const start = cursor ? Number(cursor.split("-")[1]) + 1 : 0;
    const size = Math.max(0, Math.min(take, total - start));
    return Promise.resolve(Array.from({ length: size }, (_, index) => ({ id: `row-${start + index}`, value: start + index })));
  };
}

describe("streamed personal data exports", () => {
  it("loads batches lazily and produces valid JSON", async () => {
    const calls: number[] = [];
    const counter: ExportCounter = { records: 0, sections: {} };
    const stream = personalDataStream(
      [
        { name: "account", single: () => Promise.resolve({ id: "user-1", bigValue: 10n }) },
        { name: "activity", batches: fakeRows(25, calls) },
      ],
      { userId: "user-1", generatedAt: new Date("2026-01-01T00:00:00Z") },
      counter,
      10,
    );
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(calls).toHaveLength(0);
    const chunks: string[] = [String(first.value)];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      chunks.push(String(next.value));
    }
    const parsed = JSON.parse(chunks.join(""));
    expect(parsed.format).toBe("plataforma-educativa.personal-data");
    expect(parsed.sections.account.bigValue).toBe("10");
    expect(parsed.sections.activity).toHaveLength(25);
    expect(calls).toEqual([10, 10, 10]);
    expect(counter).toEqual({ records: 26, sections: { account: 1, activity: 25 } });
  });
});

describe("streamed CSV reports", () => {
  it("pulls rows page by page instead of buffering the whole report", async () => {
    const calls: Array<{ cursor: string | undefined; take: number }> = [];
    const fakeDb = {
      enrollment: {
        findMany: (args: { where: { id?: { gt: string } }; take: number }) => {
          calls.push({ cursor: args.where.id?.gt, take: args.take });
          const start = args.where.id ? Number(args.where.id.gt.split("-")[1]) + 1 : 0;
          const size = Math.max(0, Math.min(args.take, 7 - start));
          return Promise.resolve(
            Array.from({ length: size }, (_, index) => ({
              id: `enrollment-${start + index}`,
              userId: "u",
              status: "ACTIVE",
              progressPercent: 10,
              finalScorePercent: null,
              enrolledAt: new Date("2026-01-01T00:00:00Z"),
              completedAt: null,
              lastActivityAt: null,
              user: { email: `learner${start + index}@example.com`, displayName: start + index === 0 ? "=cmd" : "Learner" },
            })),
          );
        },
      },
    };
    const service = new ReportService(fakeDb as never, null as never, null as never, null as never, null as never, null as never, null as never, null as never, 900, 72, 3);
    const counter = { rows: 0 };
    const stream = service.csvStream("course.enrollments", { courseId: "c" }, counter);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    expect(calls).toHaveLength(0);
    const parts: string[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      parts.push(String(next.value));
    }
    const csv = parts.join("");
    expect(csv.split("\r\n").filter((line) => line.length > 0)).toHaveLength(8);
    expect(csv).toContain("'=cmd");
    expect(calls.map((call) => call.take)).toEqual([3, 3, 3]);
    expect(counter.rows).toBe(7);
  });
});
