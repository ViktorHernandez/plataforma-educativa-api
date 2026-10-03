import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { base32Decode, base32Encode } from "../../src/core/crypto/base32.js";
import { FieldEncryptionError, FieldEncryptor } from "../../src/core/crypto/field-encryption.js";
import { findUnsafeContent } from "../../src/core/http/content-safety.js";
import { decodeCursor, encodeCursor } from "../../src/core/http/pagination.js";
import { parseAcceptLanguage, resolveLocale } from "../../src/core/i18n/translator.js";
import { PasswordPolicy } from "../../src/core/security/password.js";
import { hotp, verifyTotp } from "../../src/core/security/totp.js";
import { sanitizeAuditMetadata } from "../../src/core/audit/audit-service.js";
import { sanitizeFileName } from "../../src/modules/files/file-policy.js";
import { csvCell } from "../../src/modules/reports/report.service.js";
import { verifySvixSignature } from "../../src/modules/webhooks/webhook.service.js";
import { testEnv } from "../helpers/test-env.js";

describe("TOTP (RFC 6238 and RFC 4226 vectors)", () => {
  const secret = Buffer.from("12345678901234567890");

  it("matches the RFC 4226 HOTP test values", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(secret, counter)).toBe(code));
  });

  it("matches the RFC 6238 SHA-1 vectors with 8 digits", () => {
    const options = { digits: 8, periodSeconds: 30, algorithm: "sha1" as const };
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
    ];
    const encoded = base32Encode(secret);
    for (const [seconds, code] of vectors) {
      expect(verifyTotp(encoded, code, { at: new Date(seconds * 1000), window: 0, options }).valid).toBe(true);
    }
  });

  it("rejects replayed and malformed codes", () => {
    const encoded = base32Encode(secret);
    const at = new Date(59_000);
    const first = verifyTotp(encoded, hotp(secret, 1), { at });
    expect(first.valid).toBe(true);
    expect(verifyTotp(encoded, hotp(secret, 1), { at, lastUsedStep: first.step }).valid).toBe(false);
    expect(verifyTotp(encoded, "12ab56", { at }).valid).toBe(false);
  });

  it("round-trips base32", () => {
    const random = randomBytes(20);
    expect(base32Decode(base32Encode(random)).equals(random)).toBe(true);
  });
});

describe("field encryption", () => {
  const keyA = { id: "a", material: randomBytes(32).toString("base64") };
  const keyB = { id: "b", material: randomBytes(32).toString("base64") };

  it("encrypts with authenticated data and detects tampering", () => {
    const encryptor = new FieldEncryptor([keyA]);
    const ciphertext = encryptor.encrypt("JBSWY3DPEHPK3PXP", "mfa:totp:user-1");
    expect(ciphertext).not.toContain("JBSWY3DPEHPK3PXP");
    expect(encryptor.decrypt(ciphertext, "mfa:totp:user-1")).toBe("JBSWY3DPEHPK3PXP");
    expect(() => encryptor.decrypt(ciphertext, "mfa:totp:user-2")).toThrow(FieldEncryptionError);
    const parts = ciphertext.split(".");
    parts[4] = Buffer.from("tampered").toString("base64url");
    expect(() => encryptor.decrypt(parts.join("."), "mfa:totp:user-1")).toThrow(FieldEncryptionError);
  });

  it("supports key rotation", () => {
    const old = new FieldEncryptor([keyA]);
    const ciphertext = old.encrypt("secret", "ctx");
    const rotated = new FieldEncryptor([keyB, keyA]);
    expect(rotated.decrypt(ciphertext, "ctx")).toBe("secret");
    expect(rotated.needsRotation(ciphertext)).toBe(true);
    const reencrypted = rotated.rotate(ciphertext, "ctx");
    expect(rotated.needsRotation(reencrypted)).toBe(false);
    expect(new FieldEncryptor([keyB]).decrypt(reencrypted, "ctx")).toBe("secret");
  });

  it("refuses weak keys", () => {
    expect(() => new FieldEncryptor([{ id: "x", material: randomBytes(16).toString("base64") }])).toThrow();
  });
});

describe("password policy", () => {
  const policy = new PasswordPolicy(12);
  it("reports every violated rule", () => {
    expect(policy.evaluate("short").issues).toContain("TOO_SHORT");
    expect(policy.evaluate("aaaaaaaaaaaaaaaa").issues).toContain("TOO_REPETITIVE");
    expect(policy.evaluate("ana.perez2026!", { email: "ana.perez@example.com" }).issues).toContain("CONTAINS_PERSONAL_DATA");
    expect(policy.evaluate("Correct-Horse-Battery-42").valid).toBe(true);
  });
});

describe("configuration safety", () => {
  it("refuses insecure production settings", () => {
    const unsafe = { ...testEnv, APP_ENV: "production", NODE_ENV: "production", MAIL_PROVIDER: "console", CORS_ALLOWED_ORIGINS: "*" };
    expect(() => loadConfig(unsafe)).toThrow(/Unsafe production configuration/);
  });

  it("rejects malformed keyrings", () => {
    expect(() => loadConfig({ ...testEnv, ENCRYPTION_KEYS: "no-separator" })).toThrow();
  });

  it("forbids the in-memory mail provider outside tests", () => {
    expect(() => loadConfig({ ...testEnv, APP_ENV: "development" })).toThrow(/memory/);
  });
});

describe("input hardening helpers", () => {
  it("detects dangerous markup", () => {
    expect(findUnsafeContent("<script>alert(1)</script>")).not.toBeNull();
    expect(findUnsafeContent('<a href="javascript:alert(1)">x</a>')).not.toBeNull();
    expect(findUnsafeContent("<img src=x onerror=alert(1)>")).not.toBeNull();
    expect(findUnsafeContent("Usa `x < y` y **negritas**")).toBeNull();
  });

  it("sanitizes file names", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..\\..\\boot.ini")).toBe("boot.ini");
    expect(sanitizeFileName('bad<>:"|?*.txt')).toBe("bad_______.txt");
  });

  it("neutralizes CSV formula injection", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });

  it("redacts secrets in audit metadata", () => {
    const sanitized = sanitizeAuditMetadata({ password: "x", nested: { refreshToken: "y", ok: 1 } }) as Record<string, any>;
    expect(sanitized["password"]).toBe("[REDACTED]");
    expect(sanitized["nested"].refreshToken).toBe("[REDACTED]");
    expect(sanitized["nested"].ok).toBe(1);
  });

  it("validates cursors", () => {
    const cursor = encodeCursor({ id: "01a0e0a0-0000-7000-8000-000000000000" });
    expect(decodeCursor(cursor)?.id).toBe("01a0e0a0-0000-7000-8000-000000000000");
    expect(() => decodeCursor("not-a-cursor")).toThrow();
    expect(() => decodeCursor(Buffer.from(JSON.stringify({ id: "1 OR 1=1" })).toString("base64url"))).toThrow();
  });

  it("resolves locales from Accept-Language", () => {
    expect(resolveLocale(parseAcceptLanguage("fr-FR,en-US;q=0.8,es;q=0.5"))).toBe("en");
    expect(resolveLocale(parseAcceptLanguage("es-MX"))).toBe("es");
    expect(resolveLocale(parseAcceptLanguage(undefined))).toBe("es");
  });
});

describe("webhook signatures", () => {
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  const body = '{"type":"email.bounced"}';
  const sign = (id: string, timestamp: number) =>
    `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`;

  it("accepts valid signatures and rejects stale or forged ones", () => {
    const now = Date.now();
    const timestamp = Math.floor(now / 1000);
    expect(verifySvixSignature(secret, { id: "a", timestamp: String(timestamp), signature: sign("a", timestamp) }, body, now)).toBe(true);
    expect(verifySvixSignature(secret, { id: "a", timestamp: String(timestamp - 1000), signature: sign("a", timestamp - 1000) }, body, now)).toBe(false);
    expect(verifySvixSignature(secret, { id: "b", timestamp: String(timestamp), signature: sign("a", timestamp) }, body, now)).toBe(false);
    expect(verifySvixSignature(secret, { id: "a", timestamp: String(timestamp), signature: undefined }, body, now)).toBe(false);
  });
});
