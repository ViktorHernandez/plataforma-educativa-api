import { en, type MessageKey } from "./messages/en.js";
import { es } from "./messages/es.js";

export const SUPPORTED_LOCALES = ["es", "en"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = "es";

const catalogs: Record<SupportedLocale, Record<MessageKey, string>> = { es, en };

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function normalizeLocale(value: string | null | undefined): SupportedLocale | null {
  if (!value) return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return isSupportedLocale(base) ? base : null;
}

export function parseAcceptLanguage(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .slice(0, 10)
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((param) => param.trim().startsWith("q="));
      const quality = qParam ? Number(qParam.trim().slice(2)) : 1;
      return { tag: tag?.trim() ?? "", quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.tag.length <= 35 && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality)
    .map((entry) => entry.tag);
}

export function resolveLocale(...candidates: Array<string | null | undefined | string[]>): SupportedLocale {
  for (const candidate of candidates.flat()) {
    const normalized = normalizeLocale(candidate);
    if (normalized) return normalized;
  }
  return DEFAULT_LOCALE;
}

export type TranslationParams = Record<string, string | number>;

export function translate(locale: SupportedLocale, key: MessageKey, params: TranslationParams = {}): string {
  const template = catalogs[locale][key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function hasMessage(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

export function formatDateTime(date: Date, locale: SupportedLocale, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short", timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(date);
  }
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const currencies = new Set(Intl.supportedValuesOf("currency"));

export function isValidCurrency(value: string): boolean {
  return currencies.has(value);
}
