import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import type { OutboxService } from "../../core/events/outbox.js";
import { ErrorCode, conflict, notFound } from "../../core/http/errors.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { AssessmentAccommodation } from "../../generated/prisma/client.js";
import { AttemptStatus, EnrollmentStatus } from "../../generated/prisma/enums.js";
import type { AssessmentService } from "./assessment.service.js";
import { ATTEMPT_AUTOSUBMIT_EVENT, attemptDeadline } from "./attempt.service.js";

export const MAX_EXTRA_TIME_SECONDS = 86_400;

const eligibleEnrollmentStatuses: EnrollmentStatus[] = [EnrollmentStatus.ACTIVE, EnrollmentStatus.COMPLETED, EnrollmentStatus.PENDING_APPROVAL];

type AccommodationWithUser = AssessmentAccommodation & { user: { id: string; displayName: string; email: string } };

export class AccommodationService {
  constructor(
    private readonly db: Database,
    private readonly assessments: AssessmentService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  present(item: AccommodationWithUser) {
    return {
      id: item.id,
      assessmentId: item.assessmentId,
      learner: item.user,
      extraTimeSeconds: item.extraTimeSeconds,
      reason: item.reason,
      grantedById: item.grantedById,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      revokedAt: item.revokedAt,
    };
  }

  async list(actorId: string, assessmentId: string) {
    await this.assessments.requireManage(actorId, assessmentId, Permission.AssessmentAccommodate);
    const items = await this.db.assessmentAccommodation.findMany({
      where: { assessmentId },
      include: { user: { select: { id: true, displayName: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
    return items.map((item) => this.present(item));
  }

  private async applyToOpenAttempt(assessmentId: string, userId: string, extraTimeSeconds: number, requestId: string | null) {
    const assessment = await this.assessments.find(assessmentId);
    const open = await this.db.assessmentAttempt.findFirst({ where: { assessmentId, userId, status: AttemptStatus.IN_PROGRESS } });
    if (!open) return null;
    const deadlineAt = attemptDeadline(assessment, open.startedAt, extraTimeSeconds);
    const updated = await this.db.assessmentAttempt.updateMany({
      where: { id: open.id, status: AttemptStatus.IN_PROGRESS },
      data: { deadlineAt, extraTimeSeconds },
    });
    if (updated.count === 1 && deadlineAt) {
      await this.outbox.enqueue(this.db, {
        type: ATTEMPT_AUTOSUBMIT_EVENT,
        aggregateType: "attempt",
        aggregateId: open.id,
        payload: { attemptId: open.id },
        availableAt: new Date(deadlineAt.getTime() + assessment.gracePeriodSeconds * 1000 + 1000),
        requestId,
      });
    }
    return updated.count === 1 ? { attemptId: open.id, deadlineAt } : null;
  }

  async grant(actorId: string, assessmentId: string, learnerId: string, input: { extraTimeSeconds: number; reason?: string | null }, meta: RequestMeta) {
    const assessment = await this.assessments.requireManage(actorId, assessmentId, Permission.AssessmentAccommodate);
    if (!assessment.timeLimitSeconds) throw conflict(ErrorCode.BUSINESS_RULE, "Extra time only applies to timed assessments");
    if (input.extraTimeSeconds > MAX_EXTRA_TIME_SECONDS) throw conflict(ErrorCode.BUSINESS_RULE, "Extra time exceeds the allowed maximum");
    const enrollment = await this.db.enrollment.findUnique({ where: { userId_courseId: { userId: learnerId, courseId: assessment.courseId } }, select: { status: true } });
    if (!enrollment || !eligibleEnrollmentStatuses.includes(enrollment.status)) throw notFound("Learner");
    const accommodation = await this.db.assessmentAccommodation.upsert({
      where: { assessmentId_userId: { assessmentId, userId: learnerId } },
      create: { assessmentId, userId: learnerId, extraTimeSeconds: input.extraTimeSeconds, reason: input.reason ?? null, grantedById: actorId },
      update: { extraTimeSeconds: input.extraTimeSeconds, reason: input.reason ?? null, grantedById: actorId, revokedAt: null },
      include: { user: { select: { id: true, displayName: true, email: true } } },
    });
    const applied = await this.applyToOpenAttempt(assessmentId, learnerId, input.extraTimeSeconds, meta.requestId);
    await this.audit.record({
      action: "assessment.accommodation.granted",
      category: AuditCategory.ACADEMIC,
      actorId,
      resourceType: "assessment_accommodation",
      resourceId: accommodation.id,
      institutionId: assessment.institutionId,
      metadata: { assessmentId, learnerId, extraTimeSeconds: input.extraTimeSeconds, appliedToAttempt: applied?.attemptId ?? null },
      meta,
    });
    return { ...this.present(accommodation), appliedToAttemptId: applied?.attemptId ?? null };
  }

  async revoke(actorId: string, assessmentId: string, learnerId: string, meta: RequestMeta) {
    const assessment = await this.assessments.requireManage(actorId, assessmentId, Permission.AssessmentAccommodate);
    const revoked = await this.db.assessmentAccommodation.updateMany({ where: { assessmentId, userId: learnerId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (revoked.count === 0) throw notFound("Accommodation");
    const applied = await this.applyToOpenAttempt(assessmentId, learnerId, 0, meta.requestId);
    await this.audit.record({
      action: "assessment.accommodation.revoked",
      category: AuditCategory.ACADEMIC,
      actorId,
      resourceType: "assessment",
      resourceId: assessmentId,
      institutionId: assessment.institutionId,
      metadata: { learnerId, appliedToAttempt: applied?.attemptId ?? null },
      meta,
    });
  }
}
