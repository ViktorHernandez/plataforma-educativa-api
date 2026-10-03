import type { DbClient } from "../../core/database/prisma.js";
import { randomToken, sha256Hex } from "../../core/crypto/random.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { VerificationPurpose } from "../../generated/prisma/enums.js";

export interface ConsumedToken {
  userId: string;
  metadata: Record<string, unknown>;
}

export class VerificationTokenService {
  async issue(
    client: DbClient,
    params: { userId: string; purpose: VerificationPurpose; ttlSeconds: number; metadata?: Record<string, unknown> },
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);
    await client.verificationToken.deleteMany({ where: { userId: params.userId, purpose: params.purpose, consumedAt: null } });
    await client.verificationToken.create({
      data: {
        userId: params.userId,
        purpose: params.purpose,
        tokenHash: sha256Hex(token),
        expiresAt,
        metadata: (params.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    return { token, expiresAt };
  }

  async consume(client: DbClient, token: string, purpose: VerificationPurpose): Promise<ConsumedToken | null> {
    if (token.length < 20 || token.length > 200) return null;
    const record = await client.verificationToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!record || record.purpose !== purpose || record.consumedAt || record.expiresAt <= new Date()) return null;
    const result = await client.verificationToken.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (result.count !== 1) return null;
    return { userId: record.userId, metadata: (record.metadata ?? {}) as Record<string, unknown> };
  }
}
