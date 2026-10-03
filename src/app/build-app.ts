import { randomUUID } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyBaseLogger, type FastifyReply } from "fastify";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { registerErrorHandling } from "../core/http/error-handler.js";
import { AppError, ErrorCode } from "../core/http/errors.js";
import { extractClientInfo } from "../core/http/request-context.js";
import { EventLoopLoadMonitor } from "../core/observability/load-monitor.js";
import { parseAcceptLanguage, resolveLocale } from "../core/i18n/translator.js";
import { registerAuthRoutes, registerWellKnownRoutes } from "../modules/auth/auth.routes.js";
import { registerHealthRoutes } from "../modules/health/health.routes.js";
import type { Container } from "./container.js";
import { registerModuleRoutes } from "./modules.js";
import type { AppInstance } from "./types.js";

export const API_VERSION = "1.0.0";

const requestIdPattern = /^[A-Za-z0-9_-]{8,64}$/;
const loadSheddingExemptPaths = new Set(["/health/live", "/metrics"]);

function sendFrameworkError(reply: FastifyReply, status: number, requestId: string): void {
  void reply.code(status).send({ error: { code: ErrorCode.BAD_REQUEST, message: "The request could not be processed", requestId } });
}

function trustHops(hops: number) {
  return (_address: string, hop: number) => hop < hops;
}

export async function buildApp(container: Container): Promise<AppInstance> {
  const { config } = container;
  const loggerInstance: FastifyBaseLogger = container.logger;
  const app = Fastify({
    loggerInstance,
    trustProxy: typeof config.TRUST_PROXY === "number" ? trustHops(config.TRUST_PROXY) : config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    genReqId: (request) => {
      const inbound = request.headers["x-request-id"];
      return typeof inbound === "string" && requestIdPattern.test(inbound) ? inbound : randomUUID();
    },
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 300 },
    ajv: { customOptions: { removeAdditional: false } },
    return503OnClosing: true,
    frameworkErrors: (error, request, reply) => {
      const status = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 400;
      sendFrameworkError(reply, status, request.id);
    },
    forceCloseConnections: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorateRequest("auth", null);
  app.decorateRequest("locale", "es");
  app.decorateRequest("client", null as never);

  registerErrorHandling(app, config.isDevelopment);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
  });

  await app.register(fastifyCors, {
    origin: (origin, callback) => {
      if (!origin) return callback(null, false);
      callback(null, config.CORS_ALLOWED_ORIGINS.includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "idempotency-key",
      "if-match",
      "x-request-id",
      "x-csrf-token",
      "x-client-platform",
      "x-client-version",
      "x-device-id",
      "x-device-name",
      "accept-language",
    ],
    exposedHeaders: ["x-request-id", "retry-after", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "idempotent-replayed", "etag", "location"],
    maxAge: 600,
    strictPreflight: true,
  });

  await app.register(fastifyCookie, { hook: "onRequest" });

  if (config.LOAD_SHEDDING_ENABLED) {
    const loadMonitor = new EventLoopLoadMonitor({
      maxEventLoopDelayMs: config.LOAD_SHEDDING_MAX_EVENT_LOOP_DELAY_MS,
      maxEventLoopUtilization: config.LOAD_SHEDDING_MAX_EVENT_LOOP_UTILIZATION,
      sampleIntervalMs: config.LOAD_SHEDDING_SAMPLE_INTERVAL_MS,
      sustainedSamples: config.LOAD_SHEDDING_SUSTAINED_SAMPLES,
    });
    app.addHook("onReady", async () => loadMonitor.start());
    app.addHook("onClose", async () => loadMonitor.stop());
    app.addHook("onRequest", async (request) => {
      if (!loadMonitor.shedding || loadSheddingExemptPaths.has(request.url.split("?")[0] ?? "")) return;
      container.metrics.shedRequests.inc();
      throw new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, "Server under sustained load", { headers: { "retry-after": String(loadMonitor.retryAfterSeconds) } });
    });
  }

  app.addHook("onRequest", async (request, reply) => {
    request.client = extractClientInfo(request);
    request.locale = resolveLocale(parseAcceptLanguage(request.headers["accept-language"]));
    reply.header("x-request-id", request.id);
    if (request.url.startsWith("/health") || request.url === "/metrics") return;
    const state = await container.rateLimits.consume("globalIp", request.client.ip).catch((error: unknown) => {
      if (error instanceof AppError) container.metrics.rateLimited.inc({ policy: "globalIp" });
      throw error;
    });
    reply.header("ratelimit-limit", String(state.limit));
    reply.header("ratelimit-remaining", String(state.remaining));
    reply.header("ratelimit-reset", String(state.resetSeconds));
  });

  app.addHook("onSend", async (request, reply, payload) => {
    await container.idempotency.capture(request, reply.statusCode, payload);
    if (request.url.startsWith("/v1/auth") || request.url.startsWith("/v1/me")) {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
    } else if (!reply.hasHeader("cache-control")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    container.metrics.httpDuration.observe({ method: request.method, route, status_code: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });

  if (config.API_DOCS_ENABLED) {
    await app.register(fastifySwagger, {
      openapi: {
        openapi: "3.1.0",
        info: { title: "Plataforma Educativa API", version: API_VERSION },
        servers: [{ url: config.PUBLIC_API_URL }],
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(fastifySwaggerUi, { routePrefix: "/docs", staticCSP: true, uiConfig: { persistAuthorization: false } });
  }

  registerHealthRoutes(app, container, API_VERSION);
  registerWellKnownRoutes(app, container);

  await app.register(
    async (v1) => {
      const scoped = v1.withTypeProvider<ZodTypeProvider>();
      registerAuthRoutes(scoped, container);
      registerModuleRoutes(scoped, container);
    },
    { prefix: "/v1" },
  );

  return app;
}
