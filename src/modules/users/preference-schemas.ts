import { z } from "zod";

export const accessibilityPreferences = z
  .object({
    reducedMotion: z.boolean().default(false),
    highContrast: z.boolean().default(false),
    textScale: z.number().min(0.8).max(2.5).default(1),
    dyslexiaFriendlyFont: z.boolean().default(false),
    underlineLinks: z.boolean().default(false),
    captionsByDefault: z.boolean().default(false),
    audioDescriptions: z.boolean().default(false),
    transcriptsByDefault: z.boolean().default(false),
    screenReaderOptimized: z.boolean().default(false),
    keyboardShortcuts: z.boolean().default(true),
    focusMode: z.boolean().default(false),
    reduceTransparency: z.boolean().default(false),
    autoplayMedia: z.boolean().default(false),
    colorVisionMode: z.enum(["none", "protanopia", "deuteranopia", "tritanopia", "achromatopsia"]).default("none"),
    touchTargetSize: z.enum(["default", "large"]).default("default"),
    readingGuide: z.boolean().default(false),
  })
  .strict();

export const interfacePreferences = z
  .object({
    density: z.enum(["compact", "comfortable", "spacious"]).default("comfortable"),
    dateFormat: z.enum(["auto", "dmy", "mdy", "ymd"]).default("auto"),
    timeFormat: z.enum(["auto", "h12", "h24"]).default("auto"),
    weekStartsOn: z.number().int().min(0).max(6).default(1),
    homeView: z.enum(["dashboard", "courses", "calendar"]).default("dashboard"),
    sidebarCollapsed: z.boolean().default(false),
    soundEffects: z.boolean().default(false),
  })
  .strict();

export const privacyPreferences = z
  .object({
    profileVisibility: z.enum(["public", "institution", "private"]).default("institution"),
    allowDirectMessages: z.enum(["everyone", "institution", "staff_only", "nobody"]).default("institution"),
    showOnlineStatus: z.boolean().default(true),
    showProgressToPeers: z.boolean().default(false),
    analyticsConsent: z.boolean().default(false),
    marketingEmails: z.boolean().default(false),
  })
  .strict();

export type AccessibilityPreferences = z.infer<typeof accessibilityPreferences>;
export type InterfacePreferences = z.infer<typeof interfacePreferences>;
export type PrivacyPreferences = z.infer<typeof privacyPreferences>;

export function resolvePreferenceGroup<T extends z.ZodObject>(schema: T, stored: unknown): z.infer<T> {
  const base = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const parsed = schema.safeParse(base);
  if (parsed.success) return parsed.data;
  const fallback: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    const field = schema.shape[key] as z.ZodType | undefined;
    if (field && field.safeParse(value).success) fallback[key] = value;
  }
  return schema.parse(fallback);
}
