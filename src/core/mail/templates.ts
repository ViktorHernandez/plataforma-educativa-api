import type { MessageKey } from "../i18n/messages/en.js";
import { translate, type SupportedLocale, type TranslationParams } from "../i18n/translator.js";

export const EmailTemplate = {
  VerifyEmail: "verify-email",
  AccountExists: "account-exists",
  EmailChange: "email-change",
  PasswordReset: "password-reset",
  AccountSetup: "account-setup",
  PasswordChanged: "password-changed",
  NewLogin: "new-login",
  MfaEnabled: "mfa-enabled",
  MfaDisabled: "mfa-disabled",
  RecoveryCodesRegenerated: "recovery-codes-regenerated",
  OAuthLinked: "oauth-linked",
  OAuthUnlinked: "oauth-unlinked",
  SecurityAlert: "security-alert",
  PrivacyExportReady: "privacy-export-ready",
  PrivacyDeletionScheduled: "privacy-deletion-scheduled",
  PrivacyDeletionCompleted: "privacy-deletion-completed",
  Notification: "notification",
} as const;

export type EmailTemplate = (typeof EmailTemplate)[keyof typeof EmailTemplate];

interface TemplateDefinition {
  subject: MessageKey;
  body: MessageKey;
  action?: MessageKey;
}

const definitions: Record<EmailTemplate, TemplateDefinition> = {
  "verify-email": { subject: "email.verify.subject", body: "email.verify.body", action: "email.verify.action" },
  "email-change": { subject: "email.emailChange.subject", body: "email.emailChange.body", action: "email.emailChange.action" },
  "account-exists": { subject: "email.accountExists.subject", body: "email.accountExists.body", action: "email.accountExists.action" },
  "password-reset": { subject: "email.passwordReset.subject", body: "email.passwordReset.body", action: "email.passwordReset.action" },
  "account-setup": { subject: "email.accountSetup.subject", body: "email.accountSetup.body", action: "email.accountSetup.action" },
  "password-changed": { subject: "email.passwordChanged.subject", body: "email.passwordChanged.body" },
  "new-login": { subject: "email.newLogin.subject", body: "email.newLogin.body" },
  "mfa-enabled": { subject: "email.mfaEnabled.subject", body: "email.mfaEnabled.body" },
  "mfa-disabled": { subject: "email.mfaDisabled.subject", body: "email.mfaDisabled.body" },
  "recovery-codes-regenerated": { subject: "email.recoveryCodes.subject", body: "email.recoveryCodes.body" },
  "oauth-linked": { subject: "email.oauthLinked.subject", body: "email.oauthLinked.body" },
  "oauth-unlinked": { subject: "email.oauthUnlinked.subject", body: "email.oauthUnlinked.body" },
  "security-alert": { subject: "email.securityAlert.subject", body: "email.securityAlert.body" },
  "privacy-export-ready": { subject: "email.privacyExportReady.subject", body: "email.privacyExportReady.body", action: "email.privacyExportReady.action" },
  "privacy-deletion-scheduled": { subject: "email.privacyDeletionScheduled.subject", body: "email.privacyDeletionScheduled.body", action: "email.privacyDeletionScheduled.action" },
  "privacy-deletion-completed": { subject: "email.privacyDeletionCompleted.subject", body: "email.privacyDeletionCompleted.body" },
  notification: { subject: "email.notification.subject", body: "email.notification.subject", action: "email.notification.action" },
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderEmail(params: {
  template: EmailTemplate;
  locale: SupportedLocale;
  values: TranslationParams;
  actionUrl?: string;
  bodyOverride?: string;
}): RenderedEmail {
  const definition = definitions[params.template];
  const subject = translate(params.locale, definition.subject, params.values);
  const body = params.bodyOverride ?? translate(params.locale, definition.body, params.values);
  const footer = translate(params.locale, "email.footer");
  const actionLabel = definition.action ? translate(params.locale, definition.action, params.values) : null;
  const actionUrl = params.actionUrl && /^https?:\/\//.test(params.actionUrl) ? params.actionUrl : null;

  const textParts = [body];
  if (actionLabel && actionUrl) textParts.push(`${actionLabel}: ${actionUrl}`);
  textParts.push("", footer);

  const actionHtml =
    actionLabel && actionUrl
      ? `<p style="margin:24px 0"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#1f4fd1;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(actionLabel)}</a></p><p style="font-size:13px;color:#4a5568;word-break:break-all">${escapeHtml(actionUrl)}</p>`
      : "";

  const html = `<!doctype html><html lang="${params.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:24px;background:#f5f7fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a202c"><main style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px"><h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(subject)}</h1><p style="font-size:16px;line-height:1.6;margin:0">${escapeHtml(body)}</p>${actionHtml}<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"><p style="font-size:12px;color:#4a5568;line-height:1.5;margin:0">${escapeHtml(footer)}</p></main></body></html>`;

  return { subject, html, text: textParts.join("\n") };
}
