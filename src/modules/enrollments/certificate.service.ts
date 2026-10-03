import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import type { AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import { randomHumanCode } from "../../core/crypto/random.js";
import type { Database, Tx } from "../../core/database/prisma.js";
import { ErrorCode, conflict, notFound } from "../../core/http/errors.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import { CertificateStatus, NotificationCategory } from "../../generated/prisma/enums.js";
import { NotificationType } from "../notifications/notification-catalog.js";
import type { NotificationService } from "../notifications/notification.service.js";

type CertificateSnapshot = {
  learnerName: string;
  courseTitle: string;
  institutionName: string;
  completedAt: string;
  finalScorePercent: number | null;
};

export class CertificateService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  async issueForEnrollment(tx: Tx, enrollmentId: string, requestId: string | null): Promise<string | null> {
    const enrollment = await tx.enrollment.findUniqueOrThrow({
      where: { id: enrollmentId },
      include: {
        user: { select: { id: true, displayName: true, profile: { select: { firstName: true, lastName: true } } } },
        course: { select: { id: true, title: true, certificateEnabled: true, institution: { select: { name: true } } } },
        certificate: { select: { id: true } },
      },
    });
    if (!enrollment.course.certificateEnabled || enrollment.certificate) return enrollment.certificate?.id ?? null;
    const fullName = [enrollment.user.profile?.firstName, enrollment.user.profile?.lastName].filter(Boolean).join(" ");
    const snapshot: CertificateSnapshot = {
      learnerName: fullName.length > 0 ? fullName : enrollment.user.displayName,
      courseTitle: enrollment.course.title,
      institutionName: enrollment.course.institution.name,
      completedAt: (enrollment.completedAt ?? new Date()).toISOString(),
      finalScorePercent: enrollment.finalScorePercent === null ? null : Number(enrollment.finalScorePercent),
    };
    const certificate = await tx.certificate.create({
      data: {
        userId: enrollment.userId,
        courseId: enrollment.courseId,
        enrollmentId,
        verificationCode: randomHumanCode(12),
        snapshot,
      },
    });
    await this.notifications.notify(tx, {
      userId: enrollment.userId,
      category: NotificationCategory.ACADEMIC,
      type: NotificationType.CertificateIssued,
      params: { course: enrollment.course.title },
      target: { kind: "certificate", id: certificate.id },
      institutionId: enrollment.institutionId,
      requestId,
    });
    return certificate.id;
  }

  private present(certificate: { id: string; verificationCode: string; status: CertificateStatus; issuedAt: Date; revokedAt: Date | null; courseId: string | null; snapshot: unknown }) {
    const snapshot = certificate.snapshot as CertificateSnapshot;
    return {
      id: certificate.id,
      verificationCode: certificate.verificationCode,
      status: certificate.status,
      courseId: certificate.courseId,
      learnerName: snapshot.learnerName,
      courseTitle: snapshot.courseTitle,
      institutionName: snapshot.institutionName,
      completedAt: new Date(snapshot.completedAt),
      finalScorePercent: snapshot.finalScorePercent,
      issuedAt: certificate.issuedAt,
      revokedAt: certificate.revokedAt,
    };
  }

  async mine(userId: string) {
    const certificates = await this.db.certificate.findMany({ where: { userId }, orderBy: { issuedAt: "desc" } });
    return certificates.map((certificate) => this.present(certificate));
  }

  async verify(code: string) {
    const certificate = await this.db.certificate.findUnique({ where: { verificationCode: code.toUpperCase() } });
    if (!certificate) throw notFound("Certificate");
    return this.present(certificate);
  }

  async revoke(actorId: string, certificateId: string, reason: string, meta: RequestMeta) {
    const certificate = await this.db.certificate.findUnique({ where: { id: certificateId }, include: { course: { select: { institutionId: true } } } });
    if (!certificate || !certificate.course) throw notFound("Certificate");
    await this.authz.require(actorId, Permission.CertificateManage, { institutionId: certificate.course.institutionId, courseId: certificate.courseId }, { hideAs: "Certificate" });
    if (certificate.status === CertificateStatus.REVOKED) throw conflict(ErrorCode.BUSINESS_RULE, "Certificate already revoked");
    await this.db.certificate.update({ where: { id: certificateId }, data: { status: CertificateStatus.REVOKED, revokedAt: new Date(), revokedReason: reason } });
    await this.audit.record({
      action: "certificate.revoked",
      category: AuditCategory.ACADEMIC,
      actorId,
      resourceType: "certificate",
      resourceId: certificateId,
      institutionId: certificate.course.institutionId,
      metadata: { reason },
      meta,
    });
  }
}
