import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyringEntry } from "../../config/env.js";

const FORMAT_VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class FieldEncryptionError extends Error {}

export class FieldEncryptor {
  private readonly keys: Map<string, Buffer>;
  private readonly activeKeyId: string;

  constructor(entries: KeyringEntry[]) {
    if (entries.length === 0) throw new FieldEncryptionError("Encryption keyring is empty");
    this.keys = new Map();
    for (const entry of entries) {
      const key = Buffer.from(entry.material, "base64");
      if (key.length !== 32) {
        throw new FieldEncryptionError(`Encryption key ${entry.id} must be 32 bytes encoded in base64`);
      }
      this.keys.set(entry.id, key);
    }
    this.activeKeyId = entries[0]!.id;
  }

  encrypt(plaintext: string, associatedData: string): string {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [FORMAT_VERSION, this.activeKeyId, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(payload: string, associatedData: string): string {
    const parts = payload.split(".");
    if (parts.length !== 5 || parts[0] !== FORMAT_VERSION) {
      throw new FieldEncryptionError("Unsupported ciphertext format");
    }
    const [, keyId, ivPart, tagPart, dataPart] = parts as [string, string, string, string, string];
    const key = this.keys.get(keyId);
    if (!key) throw new FieldEncryptionError(`Unknown encryption key ${keyId}`);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    try {
      return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
    } catch (error) {
      throw new FieldEncryptionError("Ciphertext authentication failed", { cause: error });
    }
  }

  get activeKey(): string {
    return this.activeKeyId;
  }

  get keyIds(): string[] {
    return [...this.keys.keys()];
  }

  static keyIdOf(payload: string): string | null {
    const parts = payload.split(".");
    return parts.length === 5 && parts[0] === FORMAT_VERSION ? parts[1]! : null;
  }

  needsRotation(payload: string): boolean {
    return FieldEncryptor.keyIdOf(payload) !== this.activeKeyId;
  }

  rotate(payload: string, associatedData: string): string {
    return this.encrypt(this.decrypt(payload, associatedData), associatedData);
  }
}
