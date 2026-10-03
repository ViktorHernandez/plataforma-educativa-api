import { Emitter } from "@socket.io/redis-emitter";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { RedisKeys } from "../redis/redis.js";

export const rooms = {
  user: (userId: string) => `user:${userId}`,
  session: (sessionId: string) => `session:${sessionId}`,
  conversation: (conversationId: string) => `conversation:${conversationId}`,
};

export function realtimeAdapterKey(keys: RedisKeys): string {
  return keys.key("socket.io");
}

export class RealtimeBus {
  private readonly emitter: Emitter;

  constructor(publisher: Redis, keys: RedisKeys, logger: Logger) {
    const safePublisher = {
      publish: (channel: string, message: string | Buffer) =>
        publisher.publish(channel, message).catch((error: unknown) => {
          logger.warn({ err: error }, "realtime publish failed");
          return 0;
        }),
    };
    this.emitter = new Emitter(safePublisher, { key: realtimeAdapterKey(keys) });
  }

  async emit(room: string, event: string, payload: unknown): Promise<void> {
    this.emitter.to(room).emit(event, payload);
    return Promise.resolve();
  }

  async disconnect(room: string, reason: string): Promise<void> {
    this.emitter.to(room).emit("auth:revoked", { reason });
    this.emitter.in(room).disconnectSockets(true);
    return Promise.resolve();
  }
}
