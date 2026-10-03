import { ErrorCode, badRequest } from "./errors.js";

export interface CursorPayload {
  id: string;
  sort?: string | number;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): CursorPayload | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as CursorPayload).id === "string" &&
      /^[0-9a-f-]{36}$/i.test((parsed as CursorPayload).id)
    ) {
      return parsed as CursorPayload;
    }
  } catch {
    throw badRequest(ErrorCode.BAD_REQUEST, "Invalid cursor");
  }
  throw badRequest(ErrorCode.BAD_REQUEST, "Invalid cursor");
}

export function buildCursorPage<T extends { id: string }>(rows: T[], limit: number, sortOf?: (row: T) => string | number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    data: items,
    meta: {
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ id: last.id, sort: sortOf?.(last) }) : null,
    },
  };
}

export function offsetMetaOf(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
