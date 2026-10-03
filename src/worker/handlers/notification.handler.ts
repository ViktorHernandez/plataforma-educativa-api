import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../core/database/prisma.js";
import { resolveLocale } from "../../core/i18n/translator.js";
import type { MailProvider } from "../../core/mail/mail-provider.js";
import { EmailTemplate, renderEmail } from "../../core/mail/templates.js";
import type { PushDispatcher } from "../../core/push/push-provider.js";
import { rooms, type RealtimeBus } from "../../core/realtime/realtime-bus.js";
import { DeliveryStatus, NotificationCategory, NotificationChannel } from "../../generated/prisma/enums.js";
import { channelsHandledByNotification } from "../../modules/notifications/notification-catalog.js";
import { NotificationService } from "../../modules/notifications/notification.service.js";
import type { OutboxHandler } from "../outbox-processor.js";

const MAX_CONSECUTIVE_PUSH_FAILURES = 10;

export class RetryablePushError extends Error {}

export function createNotificationHandler(deps: {
  db: Database;
  notifications: NotificationService;
  mail: MailProvider;
  push: PushDispatcher;
  realtime: RealtimeBus;
  config: AppConfig;
}): OutboxHandler {
  const { db, notifications, mail, push, realtime, config } = deps;

  async function markDelivery(notificationId: string, channel: NotificationChannel, status: DeliveryStatus, provider: string | null, detail?: string) {
    await db.notificationDelivery.upsert({
      where: { notificationId_channel: { notificationId, channel } },
      create: { notificationId, channel, status, provider, attempts: 1, lastError: detail ?? null, sentAt: status === DeliveryStatus.SENT ? new Date() : null },
      update: { status, provider, attempts: { increment: 1 }, lastError: detail ?? null, sentAt: status === DeliveryStatus.SENT ? new Date() : null },
    });
  }

  return async ({ event, logger }) => {
    const notificationId = (event.payload as { notificationId?: string }).notificationId;
    if (!notificationId) return;
    const notification = await db.notification.findUnique({
      where: { id: notificationId },
      include: {
        user: { select: { id: true, email: true, status: true, preference: { select: { locale: true } } } },
        deliveries: { select: { channel: true, status: true } },
      },
    });
    if (!notification || notification.user.status !== "ACTIVE") return;
    const locale = resolveLocale(notification.user.preference?.locale);
    const presented = NotificationService.present(notification, locale);
    const alreadySent = new Set(notification.deliveries.filter((item) => item.status === DeliveryStatus.SENT || item.status === DeliveryStatus.SKIPPED).map((item) => item.channel));

    if (event.attempts <= 1) await realtime.emit(rooms.user(notification.userId), "notification:new", presented);

    for (const channel of channelsHandledByNotification(notification.category)) {
      if (alreadySent.has(channel)) continue;
      const enabled = await notifications.isChannelEnabled(notification.userId, notification.category, channel);
      if (!enabled) {
        await markDelivery(notification.id, channel, DeliveryStatus.SKIPPED, null, "disabled by preference");
        continue;
      }
      if (channel === NotificationChannel.EMAIL) {
        const suppressed = await db.emailSuppression.findUnique({ where: { email: notification.user.email } });
        if (suppressed) {
          await markDelivery(notification.id, channel, DeliveryStatus.SKIPPED, mail.name, "suppressed");
          continue;
        }
        const actionUrl = new URL("/notifications", config.WEB_APP_URL).toString();
        const rendered = renderEmail({ template: EmailTemplate.Notification, locale, values: { title: presented.title }, bodyOverride: presented.body, actionUrl });
        await mail.send({ to: notification.user.email, subject: rendered.subject, html: rendered.html, text: rendered.text, idempotencyKey: `${notification.id}:email` });
        await markDelivery(notification.id, channel, DeliveryStatus.SENT, mail.name);
      }
      if (channel === NotificationChannel.PUSH) {
        const channels = push.enabledChannels;
        if (channels.length === 0) {
          await markDelivery(notification.id, channel, DeliveryStatus.SKIPPED, null, "push disabled");
          continue;
        }
        const subscriptions = await db.pushSubscription.findMany({ where: { userId: notification.userId, revokedAt: null, provider: { in: channels } }, take: 20 });
        if (subscriptions.length === 0) {
          await markDelivery(notification.id, channel, DeliveryStatus.SKIPPED, null, "no subscriptions");
          continue;
        }
        let delivered = 0;
        let retryable = 0;
        const providers = new Set<string>();
        for (const subscription of subscriptions) {
          providers.add(push.providerName(subscription.provider));
          const result = await push.send({
            target: { provider: subscription.provider, token: subscription.token, p256dh: subscription.p256dh, authSecret: subscription.authSecret },
            title: presented.title,
            body: presented.body,
            urgent: notification.category === NotificationCategory.SECURITY,
            data: { notificationId: notification.id, type: notification.type, targetKind: presented.target?.kind ?? "", targetId: presented.target?.id ?? "" },
          });
          if (result.delivered) {
            delivered += 1;
            await db.pushSubscription.update({ where: { id: subscription.id }, data: { lastUsedAt: new Date(), failureCount: 0 } });
          } else if (result.invalidToken || subscription.failureCount + 1 >= MAX_CONSECUTIVE_PUSH_FAILURES) {
            await db.pushSubscription.update({ where: { id: subscription.id }, data: { revokedAt: new Date(), lastFailureAt: new Date(), failureCount: { increment: 1 } } });
          } else {
            if (result.retryable) retryable += 1;
            await db.pushSubscription.update({ where: { id: subscription.id }, data: { lastFailureAt: new Date(), failureCount: { increment: 1 } } });
          }
        }
        const providerLabel = [...providers].join(",").slice(0, 40);
        if (delivered === 0 && retryable > 0) {
          await markDelivery(notification.id, channel, DeliveryStatus.PENDING, providerLabel, "temporary push failure, retrying");
          throw new RetryablePushError("Push delivery failed temporarily");
        }
        await markDelivery(notification.id, channel, delivered > 0 ? DeliveryStatus.SENT : DeliveryStatus.FAILED, providerLabel, delivered > 0 ? undefined : "no device accepted the message");
        logger.debug({ delivered, subscriptions: subscriptions.length }, "push delivery finished");
      }
    }
  };
}
