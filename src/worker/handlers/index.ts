import type { Container } from "../../app/container.js";
import { EMAIL_SEND_EVENT } from "../../core/mail/email-queue.js";
import { ATTEMPT_AUTOSUBMIT_EVENT } from "../../modules/assessments/attempt.service.js";
import { ANNOUNCEMENT_FANOUT_EVENT } from "../../modules/notifications/announcement.service.js";
import { REPORT_EXPORT_EVENT } from "../../modules/reports/report.service.js";
import { WEBHOOK_PROCESS_EVENT } from "../../modules/webhooks/webhook.service.js";
import { NOTIFICATION_DELIVER_EVENT } from "../../modules/notifications/notification.service.js";
import { FILE_SCAN_EVENT } from "../../modules/files/file.service.js";
import { CALENDAR_SYNC_EVENT } from "../../modules/integrations/calendar.service.js";
import { PRIVACY_DELETION_EVENT, PRIVACY_EXPORT_EVENT } from "../../modules/privacy/privacy.service.js";
import { KEY_ROTATION_EVENT } from "../../modules/security/key-rotation.service.js";
import { MAX_OUTBOX_ATTEMPTS, type OutboxHandler } from "../outbox-processor.js";
import { createEmailHandler } from "./email.handler.js";
import { createNotificationHandler } from "./notification.handler.js";

export function createOutboxHandlers(container: Container): Map<string, OutboxHandler> {
  const handlers = new Map<string, OutboxHandler>();
  handlers.set(EMAIL_SEND_EVENT, createEmailHandler(container.db, container.outbox, container.mail));
  handlers.set(
    NOTIFICATION_DELIVER_EVENT,
    createNotificationHandler({
      db: container.db,
      notifications: container.notifications,
      mail: container.mail,
      push: container.push,
      realtime: container.realtime,
      config: container.config,
    }),
  );
  handlers.set(ATTEMPT_AUTOSUBMIT_EVENT, async ({ event }) => {
    const attemptId = (event.payload as { attemptId?: string }).attemptId;
    if (attemptId) await container.attempts.autoSubmitIfDue(attemptId, { ip: null, userAgent: null, requestId: event.requestId });
  });
  handlers.set(ANNOUNCEMENT_FANOUT_EVENT, async ({ event, logger }) => {
    const announcementId = (event.payload as { announcementId?: string }).announcementId;
    if (!announcementId) return;
    const created = await container.announcements.fanOut(announcementId, event.requestId);
    logger.info({ created }, "announcement fan-out finished");
  });
  handlers.set(REPORT_EXPORT_EVENT, async ({ event }) => {
    const exportId = (event.payload as { exportId?: string }).exportId;
    if (exportId) await container.reports.generate(exportId);
  });
  handlers.set(WEBHOOK_PROCESS_EVENT, async ({ event }) => {
    const webhookEventId = (event.payload as { webhookEventId?: string }).webhookEventId;
    if (webhookEventId) await container.webhooks.process(webhookEventId);
  });
  handlers.set(FILE_SCAN_EVENT, async ({ event, logger }) => {
    const fileId = (event.payload as { fileId?: string }).fileId;
    if (!fileId) return;
    const status = await container.files.scanUploaded(fileId, { attempts: event.attempts, maxAttempts: MAX_OUTBOX_ATTEMPTS, requestId: event.requestId });
    logger.info({ fileId, status }, "file scan finished");
  });
  handlers.set(PRIVACY_EXPORT_EVENT, async ({ event }) => {
    const requestId = (event.payload as { requestId?: string }).requestId;
    if (requestId) await container.privacy.generateExport(requestId);
  });
  handlers.set(PRIVACY_DELETION_EVENT, async ({ event, logger }) => {
    const requestId = (event.payload as { requestId?: string }).requestId;
    if (!requestId) return;
    const summary = await container.privacy.executeDeletion(requestId);
    if (summary) logger.info({ privacyRequestId: requestId }, "account deletion completed");
  });
  handlers.set(KEY_ROTATION_EVENT, async ({ event, logger }) => {
    const runId = (event.payload as { runId?: string }).runId;
    if (!runId) return;
    const step = await container.keyRotation.runStep(runId);
    if (step) logger.info({ ...step }, "re-encryption step finished");
  });
  handlers.set(CALENDAR_SYNC_EVENT, async ({ event, logger }) => {
    const connectionId = (event.payload as { connectionId?: string }).connectionId;
    if (!connectionId) return;
    const report = await container.calendar.sync(connectionId);
    if (report) logger.info({ connectionId, ...report }, "calendar sync finished");
  });
  return handlers;
}
