import type { Database, DbClient } from "../../core/database/prisma.js";
import type { OutboxService } from "../../core/events/outbox.js";
import { notFound } from "../../core/http/errors.js";
import { buildCursorPage, decodeCursor } from "../../core/http/pagination.js";
import { translate, type SupportedLocale } from "../../core/i18n/translator.js";
import { NotificationCategory, NotificationChannel } from "../../generated/prisma/enums.js";
import type { Notification, Prisma } from "../../generated/prisma/client.js";
import { bodyKey, defaultChannelPreferences, isMandatoryChannel, titleKey, type NotificationType } from "./notification-catalog.js";

export const NOTIFICATION_DELIVER_EVENT = "notification.deliver";

export interface NotificationTarget {
  kind: string;
  id: string;
  parentId?: string;
}

export interface NotifyInput {
  userId: string;
  category: NotificationCategory;
  type: NotificationType;
  params?: Record<string, string | number>;
  target?: NotificationTarget;
  institutionId?: string | null;
  requestId?: string | null;
}

interface NotificationData {
  params?: Record<string, string | number>;
  target?: NotificationTarget;
}

export interface PresentedNotification {
  id: string;
  category: NotificationCategory;
  type: string;
  title: string;
  body: string;
  target: NotificationTarget | null;
  readAt: Date | null;
  createdAt: Date;
}

export class NotificationService {
  constructor(
    private readonly db: Database,
    private readonly outbox: OutboxService,
  ) {}

  async notify(client: DbClient, input: NotifyInput): Promise<string> {
    const data: NotificationData = { params: input.params ?? {}, target: input.target };
    const notification = await client.notification.create({
      data: {
        userId: input.userId,
        category: input.category,
        type: input.type,
        data: data as Prisma.InputJsonValue,
        institutionId: input.institutionId ?? null,
      },
      select: { id: true },
    });
    await this.outbox.enqueue(client, {
      type: NOTIFICATION_DELIVER_EVENT,
      aggregateType: "notification",
      aggregateId: notification.id,
      payload: { notificationId: notification.id },
      requestId: input.requestId ?? null,
    });
    return notification.id;
  }

  static present(notification: Notification, locale: SupportedLocale): PresentedNotification {
    const data = (notification.data ?? {}) as NotificationData;
    const params = data.params ?? {};
    const title = titleKey(notification.type);
    const body = bodyKey(notification.type);
    return {
      id: notification.id,
      category: notification.category,
      type: notification.type,
      title: title ? translate(locale, title, params) : notification.type,
      body: body ? translate(locale, body, params) : "",
      target: data.target ?? null,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    };
  }

  async list(userId: string, locale: SupportedLocale, query: { cursor?: string; limit: number; unreadOnly?: boolean; category?: NotificationCategory }) {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.db.notification.findMany({
      where: {
        userId,
        archivedAt: null,
        ...(query.unreadOnly ? { readAt: null } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(cursor ? { id: { lt: cursor.id } } : {}),
      },
      orderBy: { id: "desc" },
      take: query.limit + 1,
    });
    const page = buildCursorPage(rows, query.limit);
    return { data: page.data.map((row) => NotificationService.present(row, locale)), meta: page.meta };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.db.notification.count({ where: { userId, readAt: null, archivedAt: null } });
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    const result = await this.db.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      const exists = await this.db.notification.count({ where: { id: notificationId, userId } });
      if (exists === 0) throw notFound("Notification");
    }
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await this.db.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return result.count;
  }

  async archive(userId: string, notificationId: string): Promise<void> {
    const result = await this.db.notification.updateMany({
      where: { id: notificationId, userId, archivedAt: null },
      data: { archivedAt: new Date(), readAt: new Date() },
    });
    if (result.count === 0) throw notFound("Notification");
  }

  async preferences(userId: string) {
    const stored = await this.db.notificationPreference.findMany({ where: { userId } });
    const overrides = new Map(stored.map((item) => [`${item.category}:${item.channel}`, item.enabled]));
    return Object.values(NotificationCategory).flatMap((category) =>
      Object.values(NotificationChannel).map((channel) => ({
        category,
        channel,
        enabled: isMandatoryChannel(category, channel) ? true : (overrides.get(`${category}:${channel}`) ?? defaultChannelPreferences[category][channel]),
        mandatory: isMandatoryChannel(category, channel),
      })),
    );
  }

  async updatePreferences(userId: string, updates: Array<{ category: NotificationCategory; channel: NotificationChannel; enabled: boolean }>) {
    const applicable = updates.filter((update) => !isMandatoryChannel(update.category, update.channel));
    await this.db.$transaction(
      applicable.map((update) =>
        this.db.notificationPreference.upsert({
          where: { userId_category_channel: { userId, category: update.category, channel: update.channel } },
          create: { userId, category: update.category, channel: update.channel, enabled: update.enabled },
          update: { enabled: update.enabled },
        }),
      ),
    );
    return this.preferences(userId);
  }

  async isChannelEnabled(userId: string, category: NotificationCategory, channel: NotificationChannel): Promise<boolean> {
    if (isMandatoryChannel(category, channel)) return true;
    const stored = await this.db.notificationPreference.findUnique({
      where: { userId_category_channel: { userId, category, channel } },
      select: { enabled: true },
    });
    return stored?.enabled ?? defaultChannelPreferences[category][channel];
  }
}
