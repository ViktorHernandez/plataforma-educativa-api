import type { Container } from "../app/container.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MaintenanceReport {
  verificationTokens: number;
  loginChallenges: number;
  refreshTokens: number;
  outboxEvents: number;
  webhookEvents: number;
}

export async function runMaintenance(container: Container, now = new Date()): Promise<MaintenanceReport> {
  const { db } = container;
  const [verificationTokens, loginChallenges, refreshTokens, outboxEvents, webhookEvents] = await Promise.all([
    db.verificationToken.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date(now.getTime() - DAY_MS) } }, { consumedAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } }] } }),
    db.loginChallenge.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - DAY_MS) } } }),
    db.refreshToken.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { rotatedAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } }] } }),
    db.outboxEvent.deleteMany({ where: { processedAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } } }),
    db.inboundWebhookEvent.deleteMany({ where: { processedAt: { lt: new Date(now.getTime() - 30 * DAY_MS) } } }),
  ]);
  return {
    verificationTokens: verificationTokens.count,
    loginChallenges: loginChallenges.count,
    refreshTokens: refreshTokens.count,
    outboxEvents: outboxEvents.count,
    webhookEvents: webhookEvents.count,
  };
}
