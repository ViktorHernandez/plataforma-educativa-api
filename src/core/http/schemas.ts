import { z } from "zod";

export const isoDateTime = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString(),
});

export const uuid = z.uuid();

export const idParams = z.object({ id: uuid }).strict();

export const errorResponse = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string(),
    }),
  })
  .describe("Error envelope");

export function dataEnvelope<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema });
}

export const cursorQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const offsetQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const cursorMeta = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const offsetMeta = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

export function cursorPage<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: cursorMeta });
}

export function offsetPage<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: offsetMeta });
}

export const okResponse = z.object({ data: z.object({ ok: z.literal(true) }) });

export const acceptedResponse = z.object({ data: z.object({ accepted: z.literal(true) }) });

export const trimmedString = (min: number, max: number) => z.string().trim().min(min).max(max);

export const email = z
  .string()
  .trim()
  .max(320)
  .pipe(z.email())
  .transform((value) => value.toLowerCase());

export const password = z.string().min(1).max(256);

export const slug = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const httpsUrl = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .refine((value) => value.startsWith("https://"), { message: "Only https URLs are allowed" });

export const standardErrors = {
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
  422: errorResponse,
  429: errorResponse,
};
