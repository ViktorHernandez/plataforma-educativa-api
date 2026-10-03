import type { DbClient } from "../../core/database/prisma.js";
import type { EmailQueue } from "../../core/mail/email-queue.js";
import { EmailTemplate } from "../../core/mail/templates.js";
import { NotificationCategory } from "../../generated/prisma/enums.js";
import { NotificationType } from "../notifications/notification-catalog.js";
import type { NotificationService } from "../notifications/notification.service.js";

export type SecurityEvent =
  | "newLogin"
  | "passwordChanged"
  | "mfaEnabled"
  | "mfaDisabled"
  | "recoveryCodesRegenerated"
  | "oauthLinked"
  | "oauthUnlinked"
  | "sessionReuse";

const emailTemplates: Record<SecurityEvent, EmailTemplate> = {
  newLogin: EmailTemplate.NewLogin,
  passwordChanged: EmailTemplate.PasswordChanged,
  mfaEnabled: EmailTemplate.MfaEnabled,
  mfaDisabled: EmailTemplate.MfaDisabled,
  recoveryCodesRegenerated: EmailTemplate.RecoveryCodesRegenerated,
  oauthLinked: EmailTemplate.OAuthLinked,
  oauthUnlinked: EmailTemplate.OAuthUnlinked,
  sessionReuse: EmailTemplate.SecurityAlert,
};

const notificationTypes: Partial<Record<SecurityEvent, NotificationType>> = {
  newLogin: NotificationType.SecurityNewLogin,
  passwordChanged: NotificationType.SecurityPasswordChanged,
  mfaEnabled: NotificationType.SecurityMfaChanged,
  mfaDisabled: NotificationType.SecurityMfaChanged,
  recoveryCodesRegenerated: NotificationType.SecurityMfaChanged,
  sessionReuse: NotificationType.SecuritySessionReuse,
};

export class SecurityNotifier {
  constructor(
    private readonly emails: EmailQueue,
    private readonly notifications: NotificationService,
  ) {}

  async notify(
    client: DbClient,
    userId: string,
    event: SecurityEvent,
    values: Record<string, string> = {},
    requestId: string | null = null,
  ): Promise<void> {
    const user = await client.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true, preference: { select: { locale: true, timezone: true } } },
    });
    if (!user) return;
    await this.emails.enqueue(client, {
      template: emailTemplates[event],
      to: user.email,
      userId,
      locale: user.preference?.locale ?? "es",
      timezone: user.preference?.timezone ?? "UTC",
      values: { name: user.displayName, ...values },
      dateValues: { date: new Date().toISOString() },
      requestId,
    });
    const notificationType = notificationTypes[event];
    if (notificationType) {
      await this.notifications.notify(client, {
        userId,
        category: NotificationCategory.SECURITY,
        type: notificationType,
        params: values,
        target: { kind: "security", id: userId },
        requestId,
      });
    }
  }
}
