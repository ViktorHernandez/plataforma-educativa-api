import argon2 from "argon2";
import { createHash } from "node:crypto";

export interface PasswordHasherOptions {
  memoryCostKib: number;
  timeCost: number;
  parallelism: number;
}

export class PasswordHasher {
  private readonly options: PasswordHasherOptions;
  private dummyHash: Promise<string> | null = null;

  constructor(options: PasswordHasherOptions) {
    this.options = options;
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: this.options.memoryCostKib,
      timeCost: this.options.timeCost,
      parallelism: this.options.parallelism,
    });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, {
      memoryCost: this.options.memoryCostKib,
      timeCost: this.options.timeCost,
      parallelism: this.options.parallelism,
    });
  }

  async simulateVerification(password: string): Promise<void> {
    this.dummyHash ??= this.hash("timing-equalization-placeholder");
    await this.verify(await this.dummyHash, password);
  }
}

export interface PasswordPolicyContext {
  email?: string;
  displayName?: string;
}

export interface PasswordPolicyResult {
  valid: boolean;
  issues: string[];
}

const commonPasswords = new Set([
  "password",
  "password123",
  "123456789012",
  "qwertyuiop123",
  "contraseña123",
  "contrasena123",
  "iloveyou1234",
  "welcome12345",
  "administrator",
  "letmein12345",
]);

export class PasswordPolicy {
  constructor(
    private readonly minLength: number,
    private readonly maxLength = 128,
  ) {}

  evaluate(password: string, context: PasswordPolicyContext = {}): PasswordPolicyResult {
    const issues: string[] = [];
    const length = [...password].length;
    if (length < this.minLength) issues.push("TOO_SHORT");
    if (length > this.maxLength) issues.push("TOO_LONG");
    if (/^\s|\s$/.test(password)) issues.push("LEADING_OR_TRAILING_SPACE");
    const lowered = password.toLowerCase();
    if (commonPasswords.has(lowered)) issues.push("TOO_COMMON");
    if (new Set(password).size < 5) issues.push("TOO_REPETITIVE");
    const emailLocal = context.email?.split("@")[0]?.toLowerCase();
    if (emailLocal && emailLocal.length >= 4 && lowered.includes(emailLocal)) issues.push("CONTAINS_PERSONAL_DATA");
    const name = context.displayName?.toLowerCase().replace(/\s+/g, "");
    if (name && name.length >= 4 && lowered.replace(/\s+/g, "").includes(name)) issues.push("CONTAINS_PERSONAL_DATA");
    return { valid: issues.length === 0, issues: [...new Set(issues)] };
  }

  get limits() {
    return { minLength: this.minLength, maxLength: this.maxLength };
  }
}

export interface BreachChecker {
  isBreached(password: string): Promise<boolean>;
}

export class DisabledBreachChecker implements BreachChecker {
  async isBreached(): Promise<boolean> {
    return false;
  }
}

export class HibpBreachChecker implements BreachChecker {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 1500,
  ) {}

  async isBreached(password: string): Promise<boolean> {
    const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    try {
      const response = await this.fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { "Add-Padding": "true", "User-Agent": "plataforma-educativa-api" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return false;
      const body = await response.text();
      return body.split("\n").some((line) => {
        const [hashSuffix, count] = line.trim().split(":");
        return hashSuffix === suffix && Number(count) > 0;
      });
    } catch {
      return false;
    }
  }
}
