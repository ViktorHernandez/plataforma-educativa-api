import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { AppConfig } from "../../config/env.js";
import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import { integrationTokenAad } from "../../core/crypto/encrypted-columns.js";
import type { FieldEncryptor } from "../../core/crypto/field-encryption.js";
import { randomToken, sha256Hex } from "../../core/crypto/random.js";
import type { Database } from "../../core/database/prisma.js";
import type { OutboxService } from "../../core/events/outbox.js";
import { ErrorCode, badRequest, notFound, serviceUnavailable } from "../../core/http/errors.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { RedisKeys } from "../../core/redis/redis.js";
import type { RateLimitService } from "../../core/security/rate-limiter.js";
import type { IntegrationConnection } from "../../generated/prisma/client.js";
import { ActorType, AssessmentStatus, EnrollmentStatus, IntegrationStatus } from "../../generated/prisma/enums.js";
import { CalendarApiError, type CalendarEventInput, type CalendarProviderClient, type CalendarProviderRegistry } from "./calendar-providers.js";

export const CALENDAR_SYNC_EVENT = "integration.calendar.sync";
export const ASSESSMENT_DEADLINE_SOURCE = "assessment_deadline";

const STATE_TTL_SECONDS = 600;
const DEADLINE_EVENT_MINUTES = 30;

interface StoredCalendarState {
  userId: string;
  provider: string;
  verifier: string;
}

export interface CalendarSyncReport {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export class CalendarIntegrationService {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly keys: RedisKeys,
    private readonly registry: CalendarProviderRegistry,
    private readonly encryptor: FieldEncryptor,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  providers() {
    return [
      { slug: "google", provider: "GOOGLE_CALENDAR", enabled: this.registry.has("google") },
      { slug: "microsoft", provider: "MICROSOFT_CALENDAR", enabled: this.registry.has("microsoft") },
    ];
  }

  redirectUri(slug: string): string {
    return `${this.config.PUBLIC_API_URL}/v1/integrations/calendar/${slug}/callback`;
  }

  private client(slug: string): CalendarProviderClient {
    const client = this.registry.get(slug);
    if (!client) throw notFound("Calendar provider");
    return client;
  }

  private resultUrl(status: "connected" | "error", reason?: string): string {
    const url = new URL("/settings/integrations", this.config.WEB_APP_URL);
    url.searchParams.set("calendar", status);
    if (reason) url.searchParams.set("reason", reason);
    return url.toString();
  }

  async startConnect(userId: string, slug: string) {
    await this.rateLimits.consume("sensitiveUser", userId);
    const client = this.client(slug);
    const state = randomToken(32);
    const verifier = randomToken(48);
    const stored: StoredCalendarState = { userId, provider: slug, verifier };
    try {
      await this.redis.set(this.keys.key("calendar-oauth", sha256Hex(state)), JSON.stringify(stored), "EX", STATE_TTL_SECONDS);
    } catch {
      throw serviceUnavailable("Calendar connection is temporarily unavailable");
    }
    return {
      authorizationUrl: client.authorizationUrl({ state, codeChallenge: s256(verifier), redirectUri: this.redirectUri(slug) }),
      expiresAt: new Date(Date.now() + STATE_TTL_SECONDS * 1000),
    };
  }

  async completeConnect(slug: string, query: { code?: string; state?: string; error?: string }, meta: RequestMeta): Promise<string> {
    if (!query.state) return this.resultUrl("error", "state");
    let raw: string | null;
    try {
      raw = await this.redis.getdel(this.keys.key("calendar-oauth", sha256Hex(query.state)));
    } catch {
      return this.resultUrl("error", "unavailable");
    }
    if (!raw) return this.resultUrl("error", "state");
    const state = JSON.parse(raw) as StoredCalendarState;
    if (state.provider !== slug) return this.resultUrl("error", "state");
    if (query.error || !query.code) return this.resultUrl("error", "denied");
    const client = this.registry.get(slug);
    if (!client) return this.resultUrl("error", "provider");
    try {
      const tokens = await client.exchangeCode({ code: query.code, codeVerifier: state.verifier, redirectUri: this.redirectUri(slug) });
      const data = {
        status: IntegrationStatus.ACTIVE,
        externalAccountEmail: tokens.accountEmail,
        accessTokenCiphertext: this.encryptor.encrypt(tokens.accessToken, integrationTokenAad(state.userId, client.provider, "access")),
        refreshTokenCiphertext: tokens.refreshToken ? this.encryptor.encrypt(tokens.refreshToken, integrationTokenAad(state.userId, client.provider, "refresh")) : null,
        scopes: tokens.scopes,
        expiresAt: tokens.expiresAt,
        syncEnabled: true,
        lastError: null,
      };
      const connection = await this.db.$transaction(async (tx) => {
        const saved = await tx.integrationConnection.upsert({
          where: { userId_provider: { userId: state.userId, provider: client.provider } },
          create: { userId: state.userId, provider: client.provider, ...data },
          update: data,
        });
        await this.outbox.enqueue(tx, { type: CALENDAR_SYNC_EVENT, aggregateType: "integration", aggregateId: saved.id, payload: { connectionId: saved.id }, requestId: meta.requestId });
        await this.audit.record(
          { action: "user.integration.connected", category: AuditCategory.SECURITY, actorId: state.userId, resourceType: "integration", resourceId: saved.id, metadata: { provider: client.provider }, meta },
          tx,
        );
        return saved;
      });
      this.logger.info({ integrationId: connection.id, provider: client.provider }, "calendar connected");
      return this.resultUrl("connected");
    } catch (error) {
      this.logger.warn({ err: error, provider: slug }, "calendar connection failed");
      return this.resultUrl("error", "exchange");
    }
  }

  async requestSync(userId: string, connectionId: string, meta: RequestMeta): Promise<void> {
    await this.rateLimits.consume("writeUser", userId);
    const connection = await this.db.integrationConnection.findFirst({ where: { id: connectionId, userId } });
    if (!connection) throw notFound("Integration");
    if (connection.status !== IntegrationStatus.ACTIVE) throw badRequest(ErrorCode.BUSINESS_RULE, "Reconnect the integration before syncing");
    await this.outbox.enqueue(this.db, { type: CALENDAR_SYNC_EVENT, aggregateType: "integration", aggregateId: connectionId, payload: { connectionId }, requestId: meta.requestId });
  }

  async enqueueAll(): Promise<number> {
    const connections = await this.db.integrationConnection.findMany({ where: { status: IntegrationStatus.ACTIVE, syncEnabled: true }, select: { id: true } });
    for (const connection of connections) {
      await this.outbox.enqueue(this.db, { type: CALENDAR_SYNC_EVENT, aggregateType: "integration", aggregateId: connection.id, payload: { connectionId: connection.id } });
    }
    return connections.length;
  }

  private async accessToken(connection: IntegrationConnection, client: CalendarProviderClient, forceRefresh = false): Promise<string> {
    const stillValid = connection.expiresAt === null || connection.expiresAt.getTime() > Date.now() + 60_000;
    if (stillValid && !forceRefresh) return this.encryptor.decrypt(connection.accessTokenCiphertext, integrationTokenAad(connection.userId, connection.provider, "access"));
    if (!connection.refreshTokenCiphertext) throw new CalendarApiError("Access token expired and no refresh token is available", 401);
    const refreshToken = this.encryptor.decrypt(connection.refreshTokenCiphertext, integrationTokenAad(connection.userId, connection.provider, "refresh"));
    const tokens = await client.refresh(refreshToken);
    await this.db.integrationConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenCiphertext: this.encryptor.encrypt(tokens.accessToken, integrationTokenAad(connection.userId, connection.provider, "access")),
        refreshTokenCiphertext: tokens.refreshToken ? this.encryptor.encrypt(tokens.refreshToken, integrationTokenAad(connection.userId, connection.provider, "refresh")) : connection.refreshTokenCiphertext,
        expiresAt: tokens.expiresAt,
      },
    });
    return tokens.accessToken;
  }

  async desiredEvents(userId: string, now = new Date()): Promise<Map<string, CalendarEventInput>> {
    const horizon = new Date(now.getTime() + this.config.CALENDAR_SYNC_WINDOW_DAYS * 24 * 3600 * 1000);
    const assessments = await this.db.assessment.findMany({
      where: {
        status: AssessmentStatus.PUBLISHED,
        deletedAt: null,
        closesAt: { gt: now, lte: horizon },
        course: { enrollments: { some: { userId, status: EnrollmentStatus.ACTIVE } } },
      },
      select: { id: true, title: true, closesAt: true, courseId: true, course: { select: { title: true } } },
      take: 500,
    });
    const events = new Map<string, CalendarEventInput>();
    for (const assessment of assessments) {
      const endsAt = assessment.closesAt!;
      events.set(assessment.id, {
        title: assessment.title,
        description: assessment.course.title,
        startsAt: new Date(endsAt.getTime() - DEADLINE_EVENT_MINUTES * 60_000),
        endsAt,
        url: new URL(`/courses/${assessment.courseId}/assessments/${assessment.id}`, this.config.WEB_APP_URL).toString(),
      });
    }
    return events;
  }

  static eventHash(event: CalendarEventInput): string {
    return sha256Hex(JSON.stringify([event.title, event.description, event.startsAt.toISOString(), event.endsAt.toISOString(), event.url]));
  }

  async sync(connectionId: string): Promise<CalendarSyncReport | null> {
    const connection = await this.db.integrationConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.status !== IntegrationStatus.ACTIVE || !connection.syncEnabled) return null;
    const client = [...this.registry.values()].find((item) => item.provider === connection.provider);
    if (!client) return null;
    const report: CalendarSyncReport = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
    try {
      let token = await this.accessToken(connection, client);
      const call = async <T>(operation: (accessToken: string) => Promise<T>): Promise<T> => {
        try {
          return await operation(token);
        } catch (error) {
          if (!(error instanceof CalendarApiError) || error.status !== 401) throw error;
          token = await this.accessToken(connection, client, true);
          return operation(token);
        }
      };
      const desired = await this.desiredEvents(connection.userId);
      const links = await this.db.calendarEventLink.findMany({ where: { connectionId, sourceType: ASSESSMENT_DEADLINE_SOURCE } });
      const linked = new Map(links.map((link) => [link.sourceId, link]));
      for (const [sourceId, event] of desired) {
        const hash = CalendarIntegrationService.eventHash(event);
        const link = linked.get(sourceId);
        if (link?.contentHash === hash) {
          report.unchanged += 1;
          continue;
        }
        const externalId = await call((accessToken) => client.upsertEvent(accessToken, link?.externalEventId ?? null, event));
        await this.db.calendarEventLink.upsert({
          where: { connectionId_sourceType_sourceId: { connectionId, sourceType: ASSESSMENT_DEADLINE_SOURCE, sourceId } },
          create: { connectionId, sourceType: ASSESSMENT_DEADLINE_SOURCE, sourceId, externalEventId: externalId, contentHash: hash },
          update: { externalEventId: externalId, contentHash: hash, syncedAt: new Date() },
        });
        if (link) report.updated += 1;
        else report.created += 1;
      }
      for (const link of links) {
        if (desired.has(link.sourceId)) continue;
        await call((accessToken) => client.deleteEvent(accessToken, link.externalEventId));
        await this.db.calendarEventLink.delete({ where: { id: link.id } });
        report.deleted += 1;
      }
      await this.db.integrationConnection.update({ where: { id: connectionId }, data: { lastSyncedAt: new Date(), lastError: null } });
      return report;
    } catch (error) {
      const message = (error instanceof Error ? error.message : "sync failed").slice(0, 500);
      const unauthorized = error instanceof CalendarApiError && (error.status === 401 || error.status === 400);
      await this.db.integrationConnection.update({ where: { id: connectionId }, data: { lastError: message, ...(unauthorized ? { status: IntegrationStatus.ERROR } : {}) } });
      if (unauthorized) {
        await this.audit.record({ action: "user.integration.sync_failed", category: AuditCategory.SECURITY, actorId: connection.userId, actorType: ActorType.SYSTEM, resourceType: "integration", resourceId: connectionId, metadata: { reason: message } });
        return null;
      }
      throw error;
    }
  }
}
