import type { DbClient } from "../database/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { outboxSensitiveAad } from "../crypto/encrypted-columns.js";
import type { FieldEncryptor } from "../crypto/field-encryption.js";

export interface OutboxEventInput {
  type: string;
  aggregateType?: string;
  aggregateId?: string;
  payload?: Record<string, unknown>;
  sensitive?: Record<string, unknown>;
  availableAt?: Date;
  requestId?: string | null;
}

export class OutboxService {
  constructor(private readonly encryptor: FieldEncryptor) {}

  static sensitiveAad(type: string): string {
    return outboxSensitiveAad(type);
  }

  async enqueue(client: DbClient, event: OutboxEventInput): Promise<string> {
    const created = await client.outboxEvent.create({
      data: {
        type: event.type,
        aggregateType: event.aggregateType ?? null,
        aggregateId: event.aggregateId ?? null,
        payload: (event.payload ?? {}) as Prisma.InputJsonValue,
        sensitivePayload: event.sensitive ? this.encryptor.encrypt(JSON.stringify(event.sensitive), OutboxService.sensitiveAad(event.type)) : null,
        requestId: event.requestId ?? null,
        availableAt: event.availableAt ?? new Date(),
      },
      select: { id: true },
    });
    return created.id;
  }

  readSensitive(type: string, ciphertext: string | null): Record<string, unknown> {
    if (!ciphertext) return {};
    return JSON.parse(this.encryptor.decrypt(ciphertext, OutboxService.sensitiveAad(type))) as Record<string, unknown>;
  }
}
