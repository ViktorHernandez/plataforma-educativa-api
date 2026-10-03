import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_EMAIL_DOMAIN, readDemoRegistry, registerDemoRecords, removeDemoData, seedDemoData, type DemoTarget } from "../../src/scripts/demo-data.js";
import { createInstitution, createUser } from "../helpers/factories.js";
import { createTestContext, resetState, type TestContext } from "../helpers/test-app.js";

let ctx: TestContext;
const localTarget: DemoTarget = { targetId: "localhost:5432/plataforma_test", host: "localhost", local: true, password: "Demo-Test-Password-2026", allowExistingData: false };
const remoteTarget: DemoTarget = { ...localTarget, targetId: "supabase:abcdefghijklmnopqrst", host: "aws-0-us-east-1.pooler.supabase.com", local: false };

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetState(ctx.container);
});

describe("demo data ownership", () => {
  it("creates, repeats and removes only the records it registered", async () => {
    const real = await createUser(ctx.container, { email: "persona.real@example.com" });
    const invited = await createUser(ctx.container, { email: `invitada@${DEMO_EMAIL_DOMAIN}` });
    const realInstitution = await createInstitution(ctx.container, "instituto-real");
    const summary = await seedDemoData(ctx.container, localTarget);
    const registry = await readDemoRegistry(ctx.container.db);
    expect(registry?.userIds).toHaveLength(6);
    expect(registry?.institutionIds).toEqual(expect.arrayContaining([summary.institutions.demo, summary.institutions.external]));
    await seedDemoData(ctx.container, localTarget);
    expect(await ctx.container.db.course.count({ where: { institutionId: summary.institutions.demo } })).toBe(3);
    expect((await readDemoRegistry(ctx.container.db))?.userIds).toHaveLength(6);

    const removed = await removeDemoData(ctx.container);
    expect(removed).toMatchObject({ users: 6, institutions: 2, courses: 4 });
    expect(await readDemoRegistry(ctx.container.db)).toBeNull();
    expect(await ctx.container.db.user.findUnique({ where: { id: real.id } })).not.toBeNull();
    expect(await ctx.container.db.user.findUnique({ where: { id: invited.id } })).not.toBeNull();
    expect(await ctx.container.db.institution.findUnique({ where: { id: realInstitution.id } })).not.toBeNull();
    expect(await removeDemoData(ctx.container)).toMatchObject({ users: 0, institutions: 0 });
  });

  it("refuses to take over accounts or institutions that already use demo identifiers", async () => {
    await createUser(ctx.container, { email: `docente@${DEMO_EMAIL_DOMAIN}` });
    await expect(seedDemoData(ctx.container, localTarget)).rejects.toThrow(/was not created by the demo seed/);
    await resetState(ctx.container);
    await createInstitution(ctx.container, "demo-instituto");
    await expect(seedDemoData(ctx.container, localTarget)).rejects.toThrow(/demo-instituto already exists/);
  });

  it("does not add demo data to a remote database that already holds other records unless told to", async () => {
    await createUser(ctx.container, { email: "persona.real@example.com" });
    await expect(seedDemoData(ctx.container, remoteTarget)).rejects.toThrow(/DEMO_ALLOW_EXISTING_DATA/);
    expect(await ctx.container.db.user.count({ where: { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } } })).toBe(0);
    await registerDemoRecords(ctx.container.db, localTarget, { userIds: [] });
    await expect(seedDemoData(ctx.container, remoteTarget)).rejects.toThrow(/belongs to localhost/);
  });
});
