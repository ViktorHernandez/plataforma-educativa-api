import { generateKeyPairSync, randomBytes } from "node:crypto";
import { generateVapidKeys } from "../src/core/push/web-push.js";

function keyId(prefix: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}${date}${randomBytes(3).toString("hex")}`;
}

function jwtEntry(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return `${keyId("jwt")}:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}`;
}

function encryptionEntry(): string {
  return `${keyId("enc")}:${randomBytes(32).toString("base64")}`;
}

function vapidLines(): string[] {
  const vapid = generateVapidKeys();
  return [`VAPID_PUBLIC_KEY=${vapid.publicKey}`, `VAPID_PRIVATE_KEY=${vapid.privateKey}`];
}

const mode = process.argv[2] ?? "all";

switch (mode) {
  case "jwt-key":
    console.log(jwtEntry());
    break;
  case "encryption-key":
    console.log(encryptionEntry());
    break;
  case "vapid":
    console.log(vapidLines().join("\n"));
    break;
  case "all":
    console.log(
      [
        `JWT_SIGNING_KEYS=${jwtEntry()}`,
        `ENCRYPTION_KEYS=${encryptionEntry()}`,
        `SECRETS_PEPPER=${randomBytes(48).toString("base64url")}`,
        `METRICS_TOKEN=${randomBytes(32).toString("base64url")}`,
        ...vapidLines(),
      ].join("\n"),
    );
    break;
  default:
    console.error("Usage: npm run secrets:generate -- [all|jwt-key|encryption-key|vapid]");
    process.exit(1);
}
