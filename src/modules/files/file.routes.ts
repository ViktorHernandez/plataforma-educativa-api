import { z } from "zod";
import type { Container } from "../../app/container.js";
import type { AppInstance } from "../../app/types.js";
import { AppError, ErrorCode, notFound } from "../../core/http/errors.js";
import { requestMeta, requireAuth } from "../../core/http/request-context.js";
import { dataEnvelope, idParams, isoDateTime, okResponse, standardErrors, trimmedString } from "../../core/http/schemas.js";
import { LocalStorageProvider } from "../../core/storage/local-storage.js";
import { FilePurpose, FileScanStatus, FileStatus, FileVisibility } from "../../generated/prisma/enums.js";

const security = [{ bearerAuth: [] }];
const tags = ["Files"];

const fileSchema = z.object({
  id: z.uuid(),
  purpose: z.enum(FilePurpose),
  status: z.enum(FileStatus),
  scanStatus: z.enum(FileScanStatus),
  visibility: z.enum(FileVisibility),
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().nullable(),
  altText: z.string().nullable(),
  createdAt: isoDateTime,
  readyAt: isoDateTime.nullable(),
  expiresAt: isoDateTime.nullable(),
});

const uploadablePurposes = [
  FilePurpose.AVATAR,
  FilePurpose.COURSE_COVER,
  FilePurpose.LESSON_MEDIA,
  FilePurpose.LESSON_RESOURCE,
  FilePurpose.CAPTION,
  FilePurpose.MESSAGE_ATTACHMENT,
  FilePurpose.SUBMISSION,
] as const;

export function registerFileRoutes(app: AppInstance, container: Container): void {
  const { files, authenticator } = container;

  app.post(
    "/files/uploads",
    {
      preHandler: authenticator.required,
      schema: {
        tags,
        security,
        summary: "Request an upload URL",
        body: z
          .object({
            purpose: z.enum(uploadablePurposes),
            fileName: trimmedString(1, 255),
            mimeType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/),
            sizeBytes: z.number().int().min(1),
            courseId: z.uuid().nullable().optional(),
            institutionId: z.uuid().nullable().optional(),
            altText: z.string().trim().max(500).nullable().optional(),
          })
          .strict(),
        response: {
          201: dataEnvelope(z.object({ file: fileSchema, upload: z.object({ method: z.literal("PUT"), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: isoDateTime }) })),
          ...standardErrors,
        },
      },
    },
    async (request, reply) => {
      reply.code(201);
      return { data: await files.createUpload(requireAuth(request).userId, request.body, requestMeta(request)) };
    },
  );

  app.post(
    "/files/:id/complete",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Validate an uploaded file and queue the antivirus scan", params: idParams, response: { 200: dataEnvelope(fileSchema), ...standardErrors } } },
    async (request) => ({ data: await files.complete(requireAuth(request).userId, request.params.id, requestMeta(request)) }),
  );

  app.get(
    "/files/:id",
    {
      preHandler: authenticator.optional,
      schema: {
        tags,
        summary: "File metadata with a short-lived download URL",
        params: idParams,
        querystring: z.object({ inline: z.stringbool().default(false) }).strict(),
        response: { 200: dataEnvelope(fileSchema.extend({ downloadUrl: z.string().nullable(), downloadUrlExpiresAt: isoDateTime.nullable() })), ...standardErrors },
      },
    },
    async (request) => ({ data: await files.describe(request.auth?.userId ?? null, request.params.id, request.query.inline) }),
  );

  app.delete(
    "/files/:id",
    { preHandler: authenticator.required, schema: { tags, security, summary: "Delete an unused file", params: idParams, response: { 200: okResponse, ...standardErrors } } },
    async (request) => {
      await files.remove(requireAuth(request).userId, request.params.id, requestMeta(request));
      return { data: { ok: true as const } };
    },
  );

  const storage = container.storage;
  if (!(storage instanceof LocalStorageProvider)) return;

  void app.register(async (local) => {
    local.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 200 * 1024 * 1024 }, (_request, body, done) => done(null, body));

    local.put("/files/local/object", { schema: { hide: true }, bodyLimit: 200 * 1024 * 1024 }, async (request, reply) => {
      const token = String((request.query as { token?: string }).token ?? "");
      const grant = storage.verifyGrant(token, "put");
      if (!grant) throw notFound();
      if (request.headers["content-type"] !== grant.contentType) throw new AppError(415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, "Unexpected content type");
      const body = request.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0 || (grant.maxBytes !== undefined && body.length > grant.maxBytes)) {
        throw new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, "Upload exceeds the declared size");
      }
      await storage.put(grant.key, body);
      return reply.code(204).send();
    });

    local.get("/files/local/object", { schema: { hide: true } }, async (request, reply) => {
      const token = String((request.query as { token?: string }).token ?? "");
      const grant = storage.verifyGrant(token, "get");
      if (!grant) throw notFound();
      const body = await storage.readAll(grant.key).catch(() => null);
      if (!body) throw notFound();
      reply.header("content-type", grant.contentType);
      reply.header("content-disposition", grant.disposition ?? "attachment");
      reply.header("x-content-type-options", "nosniff");
      reply.header("content-security-policy", "default-src 'none'; sandbox");
      reply.header("cache-control", "private, max-age=300");
      return reply.send(body);
    });
  });
}
