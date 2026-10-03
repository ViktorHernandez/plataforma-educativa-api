import { createDecipheriv, createECDH, createHmac, createPublicKey } from "node:crypto";
import { jwtVerify } from "jose";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { PushDispatcher, type PushProvider, type PushResult } from "../../src/core/push/push-provider.js";
import { encryptWebPushPayload, generateVapidKeys, isAllowedPushEndpoint, WebPushProvider } from "../../src/core/push/web-push.js";

const b64 = (value: string) => Buffer.from(value, "base64url");

const rfc8291 = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  receiverPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function decrypt(body: Buffer, receiverPrivate: Buffer, receiverPublic: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(receiverPrivate);
  const secret = ecdh.computeSecret(senderPublic);
  const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
  const prkKey = hmac(auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, senderPublic, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.lastIndexOf(2));
}

describe("Web Push encryption (RFC 8291)", () => {
  it("matches the RFC 8291 appendix A test vector byte for byte", () => {
    const body = encryptWebPushPayload(b64(rfc8291.plaintext), b64(rfc8291.receiverPublic), b64(rfc8291.auth), { salt: b64(rfc8291.salt), senderPrivateKey: b64(rfc8291.senderPrivate) });
    expect(body.toString("base64url")).toBe(rfc8291.body);
  });

  it("round-trips random payloads that the browser can decrypt", () => {
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    const auth = Buffer.from("0123456789abcdef");
    const payload = Buffer.from(JSON.stringify({ title: "Nueva calificación", body: "Tu resultado está listo" }));
    const body = encryptWebPushPayload(payload, receiver.getPublicKey(), auth);
    expect(decrypt(body, receiver.getPrivateKey(), receiver.getPublicKey(), auth).equals(payload)).toBe(true);
  });

  it("rejects malformed keys and oversized payloads", () => {
    expect(() => encryptWebPushPayload(Buffer.from("x"), Buffer.alloc(10), Buffer.alloc(16))).toThrow();
    expect(() => encryptWebPushPayload(Buffer.alloc(5000), b64(rfc8291.receiverPublic), b64(rfc8291.auth))).toThrow();
  });
});

describe("Web Push endpoints and VAPID", () => {
  const allowed = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "*.push.apple.com", "*.notify.windows.com"];

  it("only accepts https endpoints of known push services", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc", allowed)).toBe(true);
    expect(isAllowedPushEndpoint("https://api.push.apple.com/3/device/abc", allowed)).toBe(true);
    expect(isAllowedPushEndpoint("https://wns2-by3p.notify.windows.com/w/?token=abc", allowed)).toBe(true);
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/abc", allowed)).toBe(false);
    expect(isAllowedPushEndpoint("https://169.254.169.254/latest/meta-data", allowed)).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.example/x", allowed)).toBe(false);
    expect(isAllowedPushEndpoint("https://push.apple.com/x", allowed)).toBe(false);
    expect(isAllowedPushEndpoint("https://user:pass@fcm.googleapis.com/x", allowed)).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/x", allowed)).toBe(false);
  });

  it("signs VAPID tokens that verify with the published public key", async () => {
    const keys = generateVapidKeys();
    const provider = new WebPushProvider({ ...keys, subject: "mailto:soporte@example.com" }, allowed, pino({ level: "silent" }));
    const header = await provider.vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc");
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match?.[2]).toBe(keys.publicKey);
    const raw = b64(keys.publicKey);
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
    const { payload, protectedHeader } = await jwtVerify(match![1]!, publicKey, { audience: "https://fcm.googleapis.com" });
    expect(protectedHeader.alg).toBe("ES256");
    expect(payload.sub).toBe("mailto:soporte@example.com");
    expect(payload.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(24 * 3600);
  });

  it("classifies push service responses", async () => {
    const keys = generateVapidKeys();
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    const target = { provider: "WEB_PUSH" as const, token: "https://fcm.googleapis.com/fcm/send/abc", p256dh: receiver.getPublicKey().toString("base64url"), authSecret: Buffer.alloc(16, 7).toString("base64url") };
    const statuses: number[] = [201, 410, 429, 400];
    const results: PushResult[] = [];
    for (const status of statuses) {
      const fetchImpl = (() => Promise.resolve(new Response(null, { status }))) as unknown as typeof fetch;
      const provider = new WebPushProvider({ ...keys, subject: "mailto:a@example.com" }, allowed, pino({ level: "silent" }), fetchImpl);
      results.push(await provider.send({ target, title: "t", body: "b" }));
    }
    expect(results[0]).toMatchObject({ delivered: true });
    expect(results[1]).toMatchObject({ delivered: false, invalidToken: true });
    expect(results[2]).toMatchObject({ delivered: false, invalidToken: false, retryable: true });
    expect(results[3]).toMatchObject({ delivered: false, invalidToken: false, retryable: false });
    const blocked = new WebPushProvider({ ...keys, subject: "mailto:a@example.com" }, allowed, pino({ level: "silent" }), () => {
      throw new Error("must not be called");
    });
    expect(await blocked.send({ target: { ...target, token: "https://evil.example/push" }, title: "t", body: "b" })).toMatchObject({ delivered: false, invalidToken: true });
  });

  it("routes messages to the provider of each subscription and skips disabled ones", async () => {
    const sent: string[] = [];
    const fake = (name: string, enabled: boolean): PushProvider => ({
      name,
      enabled,
      send: (message) => {
        sent.push(`${name}:${message.target.token}`);
        return Promise.resolve({ delivered: true, invalidToken: false });
      },
    });
    const dispatcher = new PushDispatcher({ FCM: fake("fcm", true), WEB_PUSH: fake("webpush", false) });
    expect(dispatcher.enabledChannels).toEqual(["FCM"]);
    expect((await dispatcher.send({ target: { provider: "FCM", token: "device-token" }, title: "t", body: "b" })).delivered).toBe(true);
    expect((await dispatcher.send({ target: { provider: "WEB_PUSH", token: "https://fcm.googleapis.com/x" }, title: "t", body: "b" })).delivered).toBe(false);
    expect(sent).toEqual(["fcm:device-token"]);
  });
});
