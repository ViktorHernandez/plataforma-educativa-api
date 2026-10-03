export function mfaSecretAad(userId: string): string {
  return `mfa:totp:${userId}`;
}

export function integrationTokenAad(userId: string, provider: string, kind: "access" | "refresh"): string {
  return `integration:${provider}:${userId}:${kind}`;
}

export function outboxSensitiveAad(type: string): string {
  return `outbox:${type}`;
}

export interface EncryptedColumn {
  table: string;
  column: string;
  contextColumns: string[];
  aad(row: Record<string, string | null>): string;
}

export const encryptedColumns: EncryptedColumn[] = [
  { table: "mfa_factors", column: "secretCiphertext", contextColumns: ["userId"], aad: (row) => mfaSecretAad(row["userId"] ?? "") },
  {
    table: "integration_connections",
    column: "accessTokenCiphertext",
    contextColumns: ["userId", "provider"],
    aad: (row) => integrationTokenAad(row["userId"] ?? "", row["provider"] ?? "", "access"),
  },
  {
    table: "integration_connections",
    column: "refreshTokenCiphertext",
    contextColumns: ["userId", "provider"],
    aad: (row) => integrationTokenAad(row["userId"] ?? "", row["provider"] ?? "", "refresh"),
  },
  { table: "outbox_events", column: "sensitivePayload", contextColumns: ["type"], aad: (row) => outboxSensitiveAad(row["type"] ?? "") },
];

export function columnKey(column: EncryptedColumn): string {
  return `${column.table}.${column.column}`;
}
