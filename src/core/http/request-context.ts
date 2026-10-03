import type { FastifyRequest } from "fastify";
import { ClientPlatform } from "../../generated/prisma/enums.js";
import type { SupportedLocale } from "../i18n/translator.js";
import { unauthorized } from "./errors.js";

export interface ClientInfo {
  ip: string;
  userAgent: string | null;
  platform: ClientPlatform;
  deviceKey: string | null;
  deviceName: string | null;
  appVersion: string | null;
  origin: string | null;
}

export interface AuthContext {
  userId: string;
  sessionId: string;
  mfa: boolean;
  authMethods: string[];
  authenticatedAt: Date;
  tokenExpiresAt: Date;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
    client: ClientInfo;
    locale: SupportedLocale;
  }
}

const platformHeaderMap: Record<string, ClientPlatform> = {
  web: ClientPlatform.WEB,
  pwa: ClientPlatform.PWA,
  android: ClientPlatform.ANDROID,
  ios: ClientPlatform.IOS,
  windows: ClientPlatform.WINDOWS,
  macos: ClientPlatform.MACOS,
  linux: ClientPlatform.LINUX,
};

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function sanitizeText(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\p{Cc}/gu, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, maxLength) : null;
}

export function extractClientInfo(request: FastifyRequest): ClientInfo {
  const platformHeader = headerValue(request, "x-client-platform")?.toLowerCase() ?? "";
  const deviceHeader = headerValue(request, "x-device-id");
  const deviceKey = deviceHeader && /^[A-Za-z0-9_-]{16,128}$/.test(deviceHeader) ? deviceHeader : null;
  const versionHeader = headerValue(request, "x-client-version");
  return {
    ip: request.ip,
    userAgent: sanitizeText(headerValue(request, "user-agent"), 512),
    platform: platformHeaderMap[platformHeader] ?? ClientPlatform.OTHER,
    deviceKey,
    deviceName: sanitizeText(headerValue(request, "x-device-name"), 120),
    appVersion: versionHeader && /^[0-9A-Za-z.+-]{1,32}$/.test(versionHeader) ? versionHeader : null,
    origin: headerValue(request, "origin"),
  };
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export function requestMeta(request: FastifyRequest): RequestMeta {
  return { ip: request.client.ip, userAgent: request.client.userAgent, requestId: request.id };
}
