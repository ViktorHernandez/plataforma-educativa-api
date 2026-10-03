import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { sha256Hex } from "../crypto/random.js";
import type { RedisKeys } from "../redis/redis.js";
import { AppError, ErrorCode, badRequest, conflict, unprocessable } from "./errors.js";

interface StoredResponse {
  state: "pending" | "done";
  fingerprint: string;
  statusCode?: number;
  payload?: string;
}

interface CaptureTarget {
  storageKey: string;
  fingerprint: string;
}

const TTL_SECONDS = 24 * 60 * 60;
const PENDING_TTL_SECONDS = 60;
const captures = new WeakMap<FastifyRequest, CaptureTarget>();

export class IdempotencyService {
  constructor(
    private readonly redis: Redis,
    private readonly keys: RedisKeys,
    private readonly logger: Logger,
  ) {}

  static readKey(request: FastifyRequest): string | null {
    const header = request.headers["idempotency-key"];
    if (header === undefined) return null;
    if (typeof header !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(header)) {
      throw badRequest(ErrorCode.BAD_REQUEST, "Idempotency-Key must contain 8 to 128 URL-safe characters");
    }
    return header;
  }

  async capture(request: FastifyRequest, statusCode: number, payload: unknown): Promise<void> {
    const target = captures.get(request);
    if (!target) return;
    captures.delete(request);
    if (statusCode >= 400 || typeof payload !== "string") {
      await this.redis.del(target.storageKey).catch(() => undefined);
      return;
    }
    const done: StoredResponse = { state: "done", fingerprint: target.fingerprint, statusCode, payload };
    await this.redis.set(target.storageKey, JSON.stringify(done), "EX", TTL_SECONDS).catch((error: unknown) => {
      this.logger.warn({ err: error }, "idempotency store write failed");
    });
  }

  async run<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    scope: string,
    subject: string,
    handler: () => Promise<{ statusCode: number; body: T }>,
  ): Promise<T> {
    const idempotencyKey = IdempotencyService.readKey(request);
    if (idempotencyKey) {
      const fingerprint = sha256Hex(JSON.stringify({ body: request.body ?? null, params: request.params ?? null }));
      const storageKey = this.keys.key("idem", scope, subject, idempotencyKey);
      try {
        const pending: StoredResponse = { state: "pending", fingerprint };
        const reserved = (await this.redis.set(storageKey, JSON.stringify(pending), "EX", PENDING_TTL_SECONDS, "NX")) === "OK";
        if (reserved) {
          captures.set(request, { storageKey, fingerprint });
        } else {
          const existing = await this.redis.get(storageKey);
          if (existing) {
            const stored = JSON.parse(existing) as StoredResponse;
            if (stored.fingerprint !== fingerprint) throw unprocessable(ErrorCode.IDEMPOTENCY_CONFLICT, "Idempotency key reused with a different payload");
            if (stored.state === "pending") throw conflict(ErrorCode.IDEMPOTENCY_IN_PROGRESS, "Request with this idempotency key is in progress");
            reply.header("idempotent-replayed", "true");
            reply.code(stored.statusCode ?? 200).type("application/json; charset=utf-8");
            return reply.send(stored.payload) as unknown as T;
          }
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        this.logger.warn({ err: error }, "idempotency store unavailable, continuing without replay protection");
      }
    }
    const result = await handler();
    reply.code(result.statusCode);
    return result.body;
  }
}
