import type { Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { Server, type Socket } from "socket.io";
import type { Container } from "../../app/container.js";
import { AppError } from "../../core/http/errors.js";
import type { AuthContext } from "../../core/http/request-context.js";
import { createRedis } from "../../core/redis/redis.js";
import { realtimeAdapterKey, rooms } from "../../core/realtime/realtime-bus.js";
import { SessionStore } from "../../core/security/session-store.js";

interface SocketData {
  auth: AuthContext;
  expiryTimer?: NodeJS.Timeout;
}

type AuthedSocket = Socket<Record<string, (...args: unknown[]) => void>, Record<string, (...args: unknown[]) => void>, Record<string, never>, SocketData>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const conversationRoomPrefix = rooms.conversation("");
const MAX_REVALIDATION_CONCURRENCY = 4;

export interface RealtimeOptions {
  revalidateIntervalMs?: number;
}

export interface RealtimeGateway {
  io: Server;
  close(): Promise<void>;
}

function clientIp(socket: Socket, trustProxy: boolean | number | string[]): string {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  if (trustProxy === false || typeof forwarded !== "string") return socket.handshake.address;
  const hops = forwarded
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (hops.length === 0) return socket.handshake.address;
  if (typeof trustProxy === "number") return hops[Math.max(0, hops.length - trustProxy)] ?? socket.handshake.address;
  return hops[0]!;
}

export function attachRealtime(server: HttpServer, container: Container, options: RealtimeOptions = {}): RealtimeGateway {
  const { config, logger, metrics, authenticator, messaging, rateLimits, sessionStore } = container;
  const io = new Server(server, {
    path: "/realtime",
    transports: ["websocket"],
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, !origin || config.CORS_ALLOWED_ORIGINS.includes(origin));
    },
  });

  const redisSettings = { url: config.REDIS_URL, protocol: config.REDIS_PROTOCOL, commandTimeoutMs: config.REDIS_COMMAND_TIMEOUT_MS };
  const publisher = createRedis(redisSettings, logger, { maxRetriesPerRequest: null, commandTimeout: undefined });
  const subscriber = createRedis(redisSettings, logger, { maxRetriesPerRequest: null, commandTimeout: undefined, enableAutoPipelining: false });
  io.adapter(createAdapter(publisher, subscriber, { key: realtimeAdapterKey(container.keys), requestsTimeout: 5000 }));

  function scheduleExpiry(socket: AuthedSocket) {
    if (socket.data.expiryTimer) clearTimeout(socket.data.expiryTimer);
    const delay = Math.max(0, socket.data.auth.tokenExpiresAt.getTime() - Date.now());
    socket.data.expiryTimer = setTimeout(() => {
      socket.emit("auth:expired", { reason: "token_expired" });
      socket.disconnect(true);
    }, Math.min(delay, 2 ** 31 - 1));
  }

  async function revalidate(socket: AuthedSocket): Promise<void> {
    const auth = socket.data.auth;
    const snapshot = await sessionStore.load(auth.sessionId);
    if (!SessionStore.isUsable(snapshot) || snapshot.userId !== auth.userId) {
      socket.emit("auth:revoked", { reason: "session_revoked" });
      socket.disconnect(true);
      return;
    }
    for (const room of [...socket.rooms]) {
      if (!room.startsWith(conversationRoomPrefix)) continue;
      if (!(await messaging.canAccessConversation(auth.userId, room.slice(conversationRoomPrefix.length)))) await socket.leave(room);
    }
  }

  const revalidationConcurrency = Math.max(1, Math.min(MAX_REVALIDATION_CONCURRENCY, Math.floor(config.DATABASE_POOL_MAX / 2)));
  let revalidating = false;
  const revalidation = setInterval(() => {
    if (revalidating) return;
    revalidating = true;
    const pending = [...io.of("/").sockets.values()] as AuthedSocket[];
    let next = 0;
    const revalidateNext = async (): Promise<void> => {
      while (next < pending.length) {
        const socket = pending[next++]!;
        if (!socket.connected) continue;
        await revalidate(socket).catch((error: unknown) => logger.warn({ err: error }, "realtime session revalidation failed"));
      }
    };
    void Promise.all(Array.from({ length: Math.min(revalidationConcurrency, pending.length) }, revalidateNext)).finally(() => {
      revalidating = false;
    });
  }, options.revalidateIntervalMs ?? 60_000);
  revalidation.unref();

  io.use((socket, next) => {
    void (async () => {
      try {
        await rateLimits.consume("realtimeConnectIp", clientIp(socket, config.TRUST_PROXY));
        const token = (socket.handshake.auth as { token?: unknown }).token;
        if (typeof token !== "string" || token.length > 4096) throw new Error("UNAUTHENTICATED");
        (socket as AuthedSocket).data.auth = await authenticator.resolveToken(token);
        next();
      } catch (error) {
        next(new Error(error instanceof AppError ? error.code : "UNAUTHENTICATED"));
      }
    })();
  });

  io.on("connection", (rawSocket) => {
    const socket = rawSocket as AuthedSocket;
    const auth = socket.data.auth;
    void socket.join([rooms.user(auth.userId), rooms.session(auth.sessionId)]);
    metrics.realtimeConnections.inc();
    scheduleExpiry(socket);

    socket.on("auth:refresh", (payload: unknown, ack?: unknown) => {
      void (async () => {
        const respond = typeof ack === "function" ? (ack as (value: unknown) => void) : () => undefined;
        try {
          const token = (payload as { token?: unknown } | null)?.token;
          if (typeof token !== "string") throw new Error("invalid");
          const next = await authenticator.resolveToken(token);
          if (next.userId !== auth.userId || next.sessionId !== auth.sessionId) throw new Error("mismatch");
          socket.data.auth = next;
          scheduleExpiry(socket);
          respond({ ok: true, expiresAt: next.tokenExpiresAt.toISOString() });
        } catch {
          respond({ ok: false });
          socket.disconnect(true);
        }
      })();
    });

    socket.on("conversation:join", (payload: unknown, ack?: unknown) => {
      void (async () => {
        const respond = typeof ack === "function" ? (ack as (value: unknown) => void) : () => undefined;
        const conversationId = (payload as { conversationId?: unknown } | null)?.conversationId;
        if (typeof conversationId !== "string" || !uuidPattern.test(conversationId)) return respond({ ok: false, error: "VALIDATION_FAILED" });
        try {
          await messaging.assertCanJoinRealtime(socket.data.auth.userId, conversationId);
          await socket.join(rooms.conversation(conversationId));
          respond({ ok: true });
        } catch {
          respond({ ok: false, error: "NOT_FOUND" });
        }
      })();
    });

    socket.on("conversation:leave", (payload: unknown) => {
      const conversationId = (payload as { conversationId?: unknown } | null)?.conversationId;
      if (typeof conversationId === "string" && uuidPattern.test(conversationId)) void socket.leave(rooms.conversation(conversationId));
    });

    socket.on("conversation:typing", (payload: unknown) => {
      const conversationId = (payload as { conversationId?: unknown } | null)?.conversationId;
      if (typeof conversationId !== "string" || !socket.rooms.has(rooms.conversation(conversationId))) return;
      void container.realtime.emit(rooms.conversation(conversationId), "conversation:typing", { conversationId, userId: socket.data.auth.userId });
    });

    socket.on("disconnect", () => {
      if (socket.data.expiryTimer) clearTimeout(socket.data.expiryTimer);
      metrics.realtimeConnections.dec();
    });
  });

  return {
    io,
    close: async () => {
      clearInterval(revalidation);
      io.local.disconnectSockets(true);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.allSettled([publisher.quit(), subscriber.quit()]);
    },
  };
}
