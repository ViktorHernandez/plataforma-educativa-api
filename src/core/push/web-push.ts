import { ECDH, createECDH, createHmac, createCipheriv, createPrivateKey, randomBytes, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import type { Logger } from "pino";
import type { PushMessage, PushProvider, PushResult } from "./push-provider.js";

const RECORD_SIZE = 4096;
const KEY_INFO_PREFIX = Buffer.from("WebPush: info\0", "utf8");
const CEK_INFO = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0", "utf8");

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

export function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function isValidP256PublicKey(value: Buffer): boolean {
  if (value.length !== 65 || value[0] !== 0x04) return false;
  try {
    ECDH.convertKey(value, "prime256v1", undefined, undefined, "uncompressed");
    return true;
  } catch {
    return false;
  }
}

export interface EncryptionOverrides {
  salt?: Buffer;
  senderPrivateKey?: Buffer;
}

export function encryptWebPushPayload(payload: Buffer, receiverPublicKey: Buffer, authSecret: Buffer, overrides: EncryptionOverrides = {}): Buffer {
  if (receiverPublicKey.length !== 65 || receiverPublicKey[0] !== 0x04) throw new Error("Invalid p256dh key");
  if (authSecret.length !== 16) throw new Error("Invalid auth secret");
  if (payload.length > RECORD_SIZE - 16 - 1 - 86) throw new Error("Web push payload too large");
  const sender = createECDH("prime256v1");
  if (overrides.senderPrivateKey) sender.setPrivateKey(overrides.senderPrivateKey);
  else sender.generateKeys();
  const senderPublicKey = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(receiverPublicKey);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = expand(prkKey, Buffer.concat([KEY_INFO_PREFIX, receiverPublicKey, senderPublicKey]), 32);
  const salt = overrides.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = expand(prk, CEK_INFO, 16);
  const nonce = expand(prk, NONCE_INFO, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublicKey.length, 20);
  return Buffer.concat([header, senderPublicKey, ciphertext]);
}

export function hostMatches(host: string, pattern: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  if (normalizedPattern.startsWith("*.")) return normalizedHost.endsWith(normalizedPattern.slice(1)) && normalizedHost.length > normalizedPattern.length - 1;
  return normalizedHost === normalizedPattern;
}

export function isAllowedPushEndpoint(endpoint: string, allowedHosts: string[]): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port !== "" && url.port !== "443")) return false;
  return allowedHosts.some((pattern) => hostMatches(url.hostname, pattern));
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function vapidPrivateKeyObject(keys: VapidKeys): KeyObject {
  const publicKey = decodeBase64Url(keys.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 public key");
  const privateKey = decodeBase64Url(keys.privateKey);
  if (privateKey.length !== 32) throw new Error("VAPID_PRIVATE_KEY must be a 32 byte P-256 private key");
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: publicKey.subarray(1, 33).toString("base64url"),
      y: publicKey.subarray(33, 65).toString("base64url"),
      d: privateKey.toString("base64url"),
    },
    format: "jwk",
  });
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: ecdh.getPrivateKey().toString("base64url") };
}

export class WebPushProvider implements PushProvider {
  readonly name = "webpush";
  readonly enabled = true;
  private readonly signingKey: KeyObject;

  constructor(
    private readonly keys: VapidKeys,
    private readonly allowedHosts: string[],
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.signingKey = vapidPrivateKeyObject(keys);
  }

  async vapidAuthorization(endpoint: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
    const audience = new URL(endpoint).origin;
    const token = await new SignJWT({ sub: this.keys.subject })
      .setProtectedHeader({ typ: "JWT", alg: "ES256" })
      .setAudience(audience)
      .setExpirationTime(now + 12 * 3600)
      .sign(this.signingKey);
    return `vapid t=${token}, k=${this.keys.publicKey}`;
  }

  async send(message: PushMessage): Promise<PushResult> {
    const { target } = message;
    if (!target.p256dh || !target.authSecret) return { delivered: false, invalidToken: true, retryable: false, error: "missing web push keys" };
    if (!isAllowedPushEndpoint(target.token, this.allowedHosts)) return { delivered: false, invalidToken: true, retryable: false, error: "endpoint not allowed" };
    try {
      const body = encryptWebPushPayload(
        Buffer.from(JSON.stringify({ title: message.title, body: message.body, data: message.data ?? {} }), "utf8"),
        decodeBase64Url(target.p256dh),
        decodeBase64Url(target.authSecret),
      );
      const response = await this.fetchImpl(target.token, {
        method: "POST",
        headers: {
          authorization: await this.vapidAuthorization(target.token),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: "86400",
          urgency: message.urgent ? "high" : "normal",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 201 || response.status === 202 || response.ok) {
        return { delivered: true, invalidToken: false, providerMessageId: response.headers.get("location") ?? undefined };
      }
      const invalidToken = response.status === 404 || response.status === 410;
      const retryable = response.status === 429 || response.status >= 500;
      return { delivered: false, invalidToken, retryable, error: `Web push status ${response.status}` };
    } catch (error) {
      this.logger.warn({ err: error }, "web push failed");
      return { delivered: false, invalidToken: false, retryable: true, error: error instanceof Error ? error.message : "unknown" };
    }
  }
}
