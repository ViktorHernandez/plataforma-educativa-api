import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createECDH } from "node:crypto";
import type { PushMessage, PushProvider, PushResult } from "../../src/core/push/push-provider.js";
import { generateVapidKeys } from "../../src/core/push/web-push.js";
import { integrationTokenAad } from "../../src/core/crypto/encrypted-columns.js";
import { IntegrationProvider, NotificationCategory } from "../../src/generated/prisma/enums.js";
import { CalendarApiError, type CalendarEventInput, type CalendarProviderClient, type CalendarProviderRegistry } from "../../src/modules/integrations/calendar-providers.js";
import { NotificationType } from "../../src/modules/notifications/notification-catalog.js";
import { academicWorld, publishedCourse } from "../helpers/academic.js";
import { trueFalseAssessment } from "../helpers/assessments.js";
import { createTestContext, json, resetState, type TestContext } from "../helpers/test-app.js";

class FakeCalendar implements CalendarProviderClient {
  readonly provider = IntegrationProvider.GOOGLE_CALENDAR;
  readonly slug = "google";
  events = new Map<string, CalendarEventInput>();
  refreshes = 0;
  failNextWithUnauthorized = false;
  lastAccessToken: string | null = null;
  private counter = 0;

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL("https://calendar.provider.test/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("redirect_uri", input.redirectUri);
    return url.toString();
  }

  exchangeCode(input: { code: string }) {
    if (input.code !== "valid-code") return Promise.reject(new CalendarApiError("invalid_grant", 400));
    return Promise.resolve({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: new Date(Date.now() + 3600_000), scopes: ["calendar.events"], accountEmail: "calendar@example.com" });
  }

  refresh(refreshToken: string) {
    this.refreshes += 1;
    return Promise.resolve({ accessToken: `access-refreshed-${this.refreshes}`, refreshToken, expiresAt: new Date(Date.now() + 3600_000), scopes: ["calendar.events"] });
  }

  upsertEvent(accessToken: string, externalId: string | null, event: CalendarEventInput): Promise<string> {
    this.lastAccessToken = accessToken;
    if (this.failNextWithUnauthorized) {
      this.failNextWithUnauthorized = false;
      return Promise.reject(new CalendarApiError("expired", 401));
    }
    const id = externalId ?? `event-${(this.counter += 1)}`;
    this.events.set(id, event);
    return Promise.resolve(id);
  }

  deleteEvent(_accessToken: string, externalId: string): Promise<void> {
    this.events.delete(externalId);
    return Promise.resolve();
  }
}

class FakePush implements PushProvider {
  readonly enabled = true;
  messages: PushMessage[] = [];
  next: PushResult = { delivered: true, invalidToken: false };

  constructor(readonly name: string) {}

  send(message: PushMessage): Promise<PushResult> {
    this.messages.push(message);
    return Promise.resolve(this.next);
  }
}

const calendar = new FakeCalendar();
const webPush = new FakePush("webpush");
const fcm = new FakePush("fcm");
const vapid = generateVapidKeys();
let ctx: TestContext;
let world: Awaited<ReturnType<typeof academicWorld>>;

beforeAll(async () => {
  const registry: CalendarProviderRegistry = new Map([["google", calendar]]);
  ctx = await createTestContext({
    env: { PUSH_WEB_ENABLED: "true", VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:soporte@example.com" },
    infra: { webPush, fcm },
    container: { calendarRegistry: registry },
  });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetState(ctx.container);
  calendar.events.clear();
  calendar.refreshes = 0;
  webPush.messages = [];
  fcm.messages = [];
  webPush.next = { delivered: true, invalidToken: false };
  fcm.next = { delivered: true, invalidToken: false };
  world = await academicWorld(ctx.app, ctx.container);
});

async function connectCalendar(headers: Record<string, string>) {
  const started = await ctx.app.inject({ method: "POST", url: "/v1/me/integrations/calendar/google/connect", headers });
  expect(started.statusCode).toBe(200);
  const authorizationUrl = new URL(json(started).data.authorizationUrl);
  return authorizationUrl.searchParams.get("state")!;
}

function callback(query: Record<string, string>) {
  return ctx.app.inject({ method: "GET", url: `/v1/integrations/calendar/google/callback?${new URLSearchParams(query).toString()}` });
}

describe("calendar integrations", () => {
  it("connects with single-use state, stores encrypted tokens and keeps deadlines in sync", async () => {
    const providers = json(await ctx.app.inject({ method: "GET", url: "/v1/integrations/calendar/providers", headers: world.student.headers })).data;
    expect(providers).toEqual(expect.arrayContaining([{ slug: "google", provider: "GOOGLE_CALENDAR", enabled: true }, { slug: "microsoft", provider: "MICROSOFT_CALENDAR", enabled: false }]));
    const unknown = await ctx.app.inject({ method: "POST", url: "/v1/me/integrations/calendar/microsoft/connect", headers: world.student.headers });
    expect(unknown.statusCode).toBe(404);

    const { course } = await publishedCourse(ctx.app, world.teacher.headers, world.institution.id);
    const assessment = await trueFalseAssessment(ctx.app, world.teacher.headers, world.institution.id, course.id, { closesAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() });
    const enrollment = json(await ctx.app.inject({ method: "POST", url: `/v1/courses/${course.id}/enrollments`, headers: world.student.headers })).data;

    const forged = await callback({ code: "valid-code", state: "forged-state-value" });
    expect(forged.statusCode).toBe(302);
    expect(forged.headers.location).toContain("calendar=error");

    const state = await connectCalendar(world.student.headers);
    const connected = await callback({ code: "valid-code", state });
    expect(connected.statusCode).toBe(302);
    expect(connected.headers.location).toBe("http://app.test.local/settings/integrations?calendar=connected");
    const replay = await callback({ code: "valid-code", state });
    expect(replay.headers.location).toContain("calendar=error");

    const connection = await ctx.container.db.integrationConnection.findFirstOrThrow({ where: { userId: world.student.user.id } });
    expect(connection.accessTokenCiphertext).not.toContain("access-1");
    expect(ctx.container.encryptor.decrypt(connection.accessTokenCiphertext, integrationTokenAad(world.student.user.id, "GOOGLE_CALENDAR", "access"))).toBe("access-1");
    expect(() => ctx.container.encryptor.decrypt(connection.accessTokenCiphertext, integrationTokenAad(world.secondStudent.user.id, "GOOGLE_CALENDAR", "access"))).toThrow();

    await ctx.outbox.drain();
    expect(calendar.events.size).toBe(1);
    const [event] = [...calendar.events.values()];
    expect(event!.title).toBe("Quiz");
    expect(event!.url).toContain(assessment.id);

    await ctx.container.db.assessment.update({ where: { id: assessment.id }, data: { title: "Quiz final" } });
    calendar.failNextWithUnauthorized = true;
    expect(await ctx.container.calendar.sync(connection.id)).toMatchObject({ updated: 1, created: 0 });
    expect(calendar.refreshes).toBe(1);
    expect(calendar.lastAccessToken).toBe("access-refreshed-1");
    expect([...calendar.events.values()][0]!.title).toBe("Quiz final");
    expect(await ctx.container.calendar.sync(connection.id)).toMatchObject({ unchanged: 1 });

    await ctx.app.inject({ method: "POST", url: `/v1/enrollments/${enrollment.id}/cancel`, headers: world.student.headers, payload: {} });
    expect(await ctx.container.calendar.sync(connection.id)).toMatchObject({ deleted: 1 });
    expect(calendar.events.size).toBe(0);

    const foreignSync = await ctx.app.inject({ method: "POST", url: `/v1/me/integrations/${connection.id}/sync`, headers: world.secondStudent.headers });
    expect(foreignSync.statusCode).toBe(404);
    const ownSync = await ctx.app.inject({ method: "POST", url: `/v1/me/integrations/${connection.id}/sync`, headers: world.student.headers });
    expect(ownSync.statusCode).toBe(202);
    const listed = json(await ctx.app.inject({ method: "GET", url: "/v1/me/integrations", headers: world.student.headers })).data;
    expect(listed[0]).toMatchObject({ provider: "GOOGLE_CALENDAR", externalAccountEmail: "calendar@example.com", syncEnabled: true });
    expect(JSON.stringify(listed)).not.toContain("Ciphertext");
  });

  it("reports a failed exchange without storing anything", async () => {
    const state = await connectCalendar(world.student.headers);
    const failed = await callback({ code: "bad-code", state });
    expect(failed.headers.location).toContain("calendar=error");
    expect(await ctx.container.db.integrationConnection.count()).toBe(0);
    const denied = await callback({ error: "access_denied", state: await connectCalendar(world.student.headers) });
    expect(denied.headers.location).toContain("reason=denied");
  });
});

describe("push notifications", () => {
  function webSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/abc123") {
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    return { provider: "WEB_PUSH", endpoint, keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 3).toString("base64url") } };
  }

  it("publishes the VAPID key and validates browser subscriptions", async () => {
    const config = json(await ctx.app.inject({ method: "GET", url: "/v1/push/web/config" })).data;
    expect(config).toEqual({ enabled: true, publicKey: vapid.publicKey });
    const ssrf = await ctx.app.inject({ method: "POST", url: "/v1/me/push-subscriptions", headers: world.student.headers, payload: webSubscription("https://169.254.169.254/latest") });
    expect(ssrf.statusCode).toBe(400);
    const badKeys = await ctx.app.inject({ method: "POST", url: "/v1/me/push-subscriptions", headers: world.student.headers, payload: { ...webSubscription(), keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) } } });
    expect(badKeys.statusCode).toBe(400);
    const extra = await ctx.app.inject({ method: "POST", url: "/v1/me/push-subscriptions", headers: world.student.headers, payload: { ...webSubscription(), token: "x".repeat(30) } });
    expect(extra.statusCode).toBe(400);
    const valid = await ctx.app.inject({ method: "POST", url: "/v1/me/push-subscriptions", headers: world.student.headers, payload: webSubscription() });
    expect(valid.statusCode).toBe(201);
    expect(json(valid).data.provider).toBe("WEB_PUSH");
  });

  it("delivers through each provider, revokes expired subscriptions and retries temporary failures", async () => {
    await ctx.app.inject({ method: "POST", url: "/v1/me/push-subscriptions", headers: world.student.headers, payload: webSubscription() });
    await ctx.app.inject({ method: "POST", url: "/v1/me/push-subscriptions", headers: world.student.headers, payload: { provider: "FCM", token: "fcm-device-token-0123456789abcdef" } });
    const notify = () =>
      ctx.container.notifications.notify(ctx.container.db, { userId: world.student.user.id, category: NotificationCategory.ACADEMIC, type: NotificationType.AssessmentGraded, params: { assessment: "Quiz", score: 90 } });

    const first = await notify();
    await ctx.outbox.drain();
    expect(webPush.messages).toHaveLength(1);
    expect(webPush.messages[0]!.target.p256dh).toBeTruthy();
    expect(fcm.messages).toHaveLength(1);
    const delivery = await ctx.container.db.notificationDelivery.findUniqueOrThrow({ where: { notificationId_channel: { notificationId: first, channel: "PUSH" } } });
    expect(delivery.status).toBe("SENT");

    webPush.next = { delivered: false, invalidToken: true, error: "gone" };
    await notify();
    await ctx.outbox.drain();
    const web = await ctx.container.db.pushSubscription.findFirstOrThrow({ where: { provider: "WEB_PUSH" } });
    expect(web.revokedAt).not.toBeNull();

    fcm.next = { delivered: false, invalidToken: false, retryable: true, error: "unavailable" };
    const third = await notify();
    await ctx.outbox.drain();
    const pending = await ctx.container.db.notificationDelivery.findUniqueOrThrow({ where: { notificationId_channel: { notificationId: third, channel: "PUSH" } } });
    expect(pending.status).toBe("PENDING");
    const event = await ctx.container.db.outboxEvent.findFirstOrThrow({ where: { type: "notification.deliver", aggregateId: third } });
    expect(event.processedAt).toBeNull();
    expect(event.lastError).toContain("temporarily");
    fcm.next = { delivered: true, invalidToken: false };
    await ctx.container.db.outboxEvent.update({ where: { id: event.id }, data: { availableAt: new Date(Date.now() - 1000) } });
    await ctx.outbox.drain();
    const sent = await ctx.container.db.notificationDelivery.findUniqueOrThrow({ where: { notificationId_channel: { notificationId: third, channel: "PUSH" } } });
    expect(sent.status).toBe("SENT");
    const fcmSubscription = await ctx.container.db.pushSubscription.findFirstOrThrow({ where: { provider: "FCM" } });
    expect(fcmSubscription.failureCount).toBe(0);
    expect(fcmSubscription.revokedAt).toBeNull();
  });
});
