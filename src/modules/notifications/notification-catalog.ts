import { NotificationCategory, NotificationChannel } from "../../generated/prisma/enums.js";
import type { MessageKey } from "../../core/i18n/messages/en.js";
import { hasMessage } from "../../core/i18n/translator.js";

export const NotificationType = {
  EnrollmentActivated: "enrollment.activated",
  EnrollmentPending: "enrollment.pending",
  EnrollmentRejected: "enrollment.rejected",
  EnrollmentRequested: "enrollment.requested",
  CourseCompleted: "course.completed",
  CertificateIssued: "certificate.issued",
  AssessmentGraded: "assessment.graded",
  AnnouncementPublished: "announcement.published",
  MessageReceived: "message.received",
  SecurityNewLogin: "security.newLogin",
  SecurityPasswordChanged: "security.passwordChanged",
  SecurityMfaChanged: "security.mfaChanged",
  SecuritySessionReuse: "security.sessionReuse",
  PrivacyExportReady: "privacy.exportReady",
} as const;

export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export function titleKey(type: string): MessageKey | null {
  const key = `notification.${type}.title`;
  return hasMessage(key) ? key : null;
}

export function bodyKey(type: string): MessageKey | null {
  const key = `notification.${type}.body`;
  return hasMessage(key) ? key : null;
}

export const defaultChannelPreferences: Record<NotificationCategory, Record<NotificationChannel, boolean>> = {
  SECURITY: { IN_APP: true, EMAIL: true, PUSH: true },
  ACADEMIC: { IN_APP: true, EMAIL: true, PUSH: true },
  COMMUNICATION: { IN_APP: true, EMAIL: false, PUSH: true },
  ADMINISTRATIVE: { IN_APP: true, EMAIL: true, PUSH: false },
  SYSTEM: { IN_APP: true, EMAIL: false, PUSH: false },
};

export function isMandatoryChannel(category: NotificationCategory, channel: NotificationChannel): boolean {
  return (category === NotificationCategory.SECURITY && channel !== NotificationChannel.PUSH) || channel === NotificationChannel.IN_APP;
}

export function channelsHandledByNotification(category: NotificationCategory): NotificationChannel[] {
  if (category === NotificationCategory.SECURITY) return [NotificationChannel.PUSH];
  return [NotificationChannel.EMAIL, NotificationChannel.PUSH];
}
