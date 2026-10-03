import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { Prisma } from "../../generated/prisma/client.js";
import { hasMessage, translate } from "../i18n/translator.js";
import { AppError, ErrorCode } from "./errors.js";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

function localizedMessage(request: FastifyRequest, code: string, fallback: string): string {
  const key = `errors.${code}`;
  return hasMessage(key) ? translate(request.locale ?? "es", key) : fallback;
}

function send(request: FastifyRequest, reply: FastifyReply, status: number, code: string, fallback: string, details?: unknown) {
  const body: ErrorBody = {
    error: {
      code,
      message: localizedMessage(request, code, fallback),
      requestId: request.id,
    },
  };
  if (details !== undefined) body.error.details = details;
  return reply.status(status).type("application/json; charset=utf-8").send(body);
}

function mapPrismaError(error: Prisma.PrismaClientKnownRequestError): { status: number; code: ErrorCode } | null {
  switch (error.code) {
    case "P2002":
      return { status: 409, code: ErrorCode.CONFLICT };
    case "P2025":
      return { status: 404, code: ErrorCode.NOT_FOUND };
    case "P2003":
      return { status: 409, code: ErrorCode.CONFLICT };
    case "P2034":
      return { status: 409, code: ErrorCode.CONFLICT };
    default:
      return null;
  }
}

export function registerErrorHandling(app: FastifyInstance, exposeInternalErrors: boolean): void {
  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    if (error instanceof AppError) {
      for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
      if (error.statusCode >= 500) request.log.error({ err: error }, "application error");
      return send(request, reply, error.statusCode, error.code, error.message, error.details);
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation.map((issue) => ({
        location: error.validationContext ?? "request",
        path: issue.instancePath.replace(/^\//, "").replace(/\//g, ".") || undefined,
        message: issue.message,
      }));
      return send(request, reply, 400, ErrorCode.VALIDATION_FAILED, "The request contains invalid data", { issues });
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error, route: request.routeOptions.url }, "response serialization failed");
      return send(request, reply, 500, ErrorCode.INTERNAL_ERROR, "An unexpected error occurred");
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = mapPrismaError(error);
      if (mapped) {
        request.log.info({ prismaCode: error.code }, "database constraint mapped to client error");
        return send(request, reply, mapped.status, mapped.code, "The request conflicts with the current state");
      }
    }

    const fastifyError = error as FastifyError;
    const statusCode = fastifyError.statusCode ?? 500;
    if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE" || statusCode === 413) {
      return send(request, reply, 413, ErrorCode.PAYLOAD_TOO_LARGE, "The request is too large");
    }
    if (fastifyError.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || statusCode === 415) {
      return send(request, reply, 415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, "Unsupported content type");
    }
    if (statusCode === 429) {
      return send(request, reply, 429, ErrorCode.RATE_LIMITED, "Too many requests");
    }
    if (statusCode === 503) {
      return send(request, reply, 503, ErrorCode.SERVICE_UNAVAILABLE, "Service temporarily unavailable");
    }
    if (statusCode >= 400 && statusCode < 500) {
      return send(request, reply, statusCode, ErrorCode.BAD_REQUEST, "The request could not be processed");
    }

    request.log.error({ err: error }, "unhandled error");
    const details = exposeInternalErrors ? { name: error.name, message: error.message } : undefined;
    return send(request, reply, 500, ErrorCode.INTERNAL_ERROR, "An unexpected error occurred", details);
  });

  app.setNotFoundHandler((request, reply) => send(request, reply, 404, ErrorCode.NOT_FOUND, "The resource was not found"));
}
