import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes, type RateLimiterAbstract } from "rate-limiter-flexible";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { sha256Hex } from "../crypto/random.js";
import { tooManyRequests } from "../http/errors.js";

export interface RateLimitPolicy {
  points: number;
  durationSeconds: number;
  blockSeconds?: number;
}

export const rateLimitPolicies = {
  globalIp: { points: 1200, durationSeconds: 60 },
  loginAttemptIp: { points: 30, durationSeconds: 60 },
  loginFailureAccountIp: { points: 5, durationSeconds: 900, blockSeconds: 900 },
  loginFailureAccount: { points: 20, durationSeconds: 3600, blockSeconds: 3600 },
  loginFailureIp: { points: 200, durationSeconds: 3600, blockSeconds: 900 },
  registerIp: { points: 10, durationSeconds: 3600 },
  passwordForgotAccount: { points: 3, durationSeconds: 3600 },
  passwordForgotIp: { points: 20, durationSeconds: 3600 },
  tokenRedeemIp: { points: 20, durationSeconds: 900 },
  verificationResendAccount: { points: 3, durationSeconds: 3600 },
  mfaVerifyUser: { points: 10, durationSeconds: 900, blockSeconds: 900 },
  mfaManageUser: { points: 10, durationSeconds: 3600 },
  oauthIp: { points: 30, durationSeconds: 60 },
  refreshIp: { points: 60, durationSeconds: 60 },
  sensitiveUser: { points: 10, durationSeconds: 3600 },
  writeUser: { points: 240, durationSeconds: 60 },
  messageUser: { points: 30, durationSeconds: 60 },
  uploadUser: { points: 60, durationSeconds: 3600 },
  progressUser: { points: 120, durationSeconds: 60 },
  adminUser: { points: 600, durationSeconds: 60 },
  expensiveUser: { points: 10, durationSeconds: 3600 },
  webhookIp: { points: 600, durationSeconds: 60 },
  realtimeConnectIp: { points: 60, durationSeconds: 60 },
} satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof rateLimitPolicies;

export interface RateLimitState {
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export class RateLimitService {
  private readonly limiters = new Map<RateLimitPolicyName, RateLimiterAbstract>();

  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
    private readonly logger: Logger,
    private readonly overrides: Partial<Record<RateLimitPolicyName, RateLimitPolicy>> = {},
  ) {}

  policy(name: RateLimitPolicyName): RateLimitPolicy {
    return this.overrides[name] ?? rateLimitPolicies[name];
  }

  private limiter(name: RateLimitPolicyName): RateLimiterAbstract {
    const existing = this.limiters.get(name);
    if (existing) return existing;
    const policy = this.policy(name);
    const common = {
      keyPrefix: `${this.keyPrefix}rl:${name}`,
      points: policy.points,
      duration: policy.durationSeconds,
      blockDuration: policy.blockSeconds ?? 0,
    };
    const limiter = new RateLimiterRedis({
      ...common,
      storeClient: this.redis,
      rejectIfRedisNotReady: true,
      insuranceLimiter: new RateLimiterMemory(common),
    });
    this.limiters.set(name, limiter);
    return limiter;
  }

  static subject(value: string): string {
    return sha256Hex(value.trim().toLowerCase()).slice(0, 40);
  }

  async consume(name: RateLimitPolicyName, key: string, points = 1): Promise<RateLimitState> {
    const policy = this.policy(name);
    try {
      const result = await this.limiter(name).consume(key, points);
      return { limit: policy.points, remaining: result.remainingPoints, resetSeconds: Math.ceil(result.msBeforeNext / 1000) };
    } catch (rejection) {
      if (rejection instanceof RateLimiterRes) {
        throw tooManyRequests(rejection.msBeforeNext / 1000);
      }
      this.logger.error({ err: rejection, policy: name }, "rate limiter failure");
      throw rejection;
    }
  }

  async assertNotBlocked(name: RateLimitPolicyName, key: string): Promise<void> {
    const policy = this.policy(name);
    let state: RateLimiterRes | null;
    try {
      state = await this.limiter(name).get(key);
    } catch (error) {
      this.logger.warn({ err: error, policy: name }, "rate limiter read failure");
      return;
    }
    if (state && state.consumedPoints >= policy.points && state.msBeforeNext > 0) {
      throw tooManyRequests(state.msBeforeNext / 1000);
    }
  }

  async penalize(name: RateLimitPolicyName, key: string): Promise<void> {
    try {
      await this.limiter(name).penalty(key, 1);
      const policy = this.policy(name);
      const state = await this.limiter(name).get(key);
      if (policy.blockSeconds && state && state.consumedPoints >= policy.points) {
        await this.limiter(name).block(key, policy.blockSeconds);
      }
    } catch (error) {
      this.logger.warn({ err: error, policy: name }, "rate limiter penalty failure");
    }
  }

  async reset(name: RateLimitPolicyName, key: string): Promise<void> {
    try {
      await this.limiter(name).delete(key);
    } catch (error) {
      this.logger.warn({ err: error, policy: name }, "rate limiter reset failure");
    }
  }
}
