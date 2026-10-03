import type { AuditService } from "../../core/audit/audit-service.js";
import { AuditCategory } from "../../core/audit/audit-service.js";
import type { AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import type { OutboxService } from "../../core/events/outbox.js";
import { assertSafeRichText } from "../../core/http/content-safety.js";
import { notFound } from "../../core/http/errors.js";
import { buildCursorPage, decodeCursor } from "../../core/http/pagination.js";
import type { RequestMeta } from "../../core/http/request-context.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AnnouncementAudience, EnrollmentStatus, MembershipStatus, NotificationCategory } from "../../generated/prisma/enums.js";
import type { CourseAccessService } from "../courses/course-access.service.js";
import { NotificationType } from "./notification-catalog.js";
import { NOTIFICATION_DELIVER_EVENT } from "./notification.service.js";

export const ANNOUNCEMENT_FANOUT_EVENT = "announcement.fanout";
const FANOUT_BATCH = 500;

export class AnnouncementService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthorizationService,
    private readonly access: CourseAccessService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async createForCourse(actorId: string, courseId: string, input: { title: string; body: string }, meta: RequestMeta) {
    const course = await this.access.requireManage(actorId, courseId, Permission.AnnouncementCreate);
    return this.create(actorId, { institutionId: course.institutionId, courseId, audience: AnnouncementAudience.COURSE, ...input }, meta);
  }

  async createForInstitution(actorId: string, institutionId: string, input: { title: string; body: string }, meta: RequestMeta) {
    await this.authz.require(actorId, Permission.InstitutionMembersManage, { institutionId }, { hideAs: "Institution" });
    return this.create(actorId, { institutionId, courseId: null, audience: AnnouncementAudience.INSTITUTION, ...input }, meta);
  }

  private async create(actorId: string, input: { institutionId: string; courseId: string | null; audience: AnnouncementAudience; title: string; body: string }, meta: RequestMeta) {
    assertSafeRichText(input.body, "body");
    return this.db.$transaction(async (tx) => {
      const announcement = await tx.announcement.create({ data: { ...input, authorId: actorId } });
      await this.outbox.enqueue(tx, { type: ANNOUNCEMENT_FANOUT_EVENT, aggregateType: "announcement", aggregateId: announcement.id, payload: { announcementId: announcement.id }, requestId: meta.requestId });
      await this.audit.record(
        { action: "announcement.published", category: AuditCategory.ACADEMIC, actorId, resourceType: "announcement", resourceId: announcement.id, institutionId: input.institutionId, meta },
        tx,
      );
      return announcement;
    });
  }

  async listForCourse(actorId: string, courseId: string, query: { cursor?: string; limit: number }) {
    const course = await this.access.findCourse(courseId);
    const staff = await this.access.can(actorId, Permission.CourseRead, course);
    if (!staff && !(await this.access.learnerEnrollment(actorId, courseId))) throw notFound("Course");
    return this.page({ courseId }, query);
  }

  async listForInstitution(actorId: string, institutionId: string, query: { cursor?: string; limit: number }) {
    if (!(await this.access.isInstitutionMember(actorId, institutionId)) && !(await this.authz.can(actorId, Permission.InstitutionRead, { institutionId }))) throw notFound("Institution");
    return this.page({ institutionId, audience: AnnouncementAudience.INSTITUTION }, query);
  }

  private async page(where: Prisma.AnnouncementWhereInput, query: { cursor?: string; limit: number }) {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.db.announcement.findMany({
      where: { ...where, ...(cursor ? { id: { lt: cursor.id } } : {}) },
      orderBy: { id: "desc" },
      take: query.limit + 1,
      include: { author: { select: { id: true, displayName: true } } },
    });
    return buildCursorPage(rows, query.limit);
  }

  async fanOut(announcementId: string, requestId: string | null): Promise<number> {
    const announcement = await this.db.announcement.findUnique({ where: { id: announcementId }, include: { course: { select: { title: true } }, institution: { select: { name: true } } } });
    if (!announcement) return 0;
    const context = announcement.course?.title ?? announcement.institution.name;
    let cursor: string | undefined;
    let total = 0;
    for (;;) {
      const recipients =
        announcement.audience === AnnouncementAudience.COURSE && announcement.courseId
          ? await this.db.enrollment.findMany({
              where: { courseId: announcement.courseId, status: { in: [EnrollmentStatus.ACTIVE, EnrollmentStatus.PENDING_APPROVAL] }, ...(cursor ? { userId: { gt: cursor } } : {}) },
              select: { userId: true },
              orderBy: { userId: "asc" },
              take: FANOUT_BATCH,
            })
          : await this.db.institutionMembership.findMany({
              where: { institutionId: announcement.institutionId, status: MembershipStatus.ACTIVE, ...(cursor ? { userId: { gt: cursor } } : {}) },
              select: { userId: true },
              orderBy: { userId: "asc" },
              take: FANOUT_BATCH,
            });
      const userIds = recipients.map((item) => item.userId).filter((id) => id !== announcement.authorId);
      if (userIds.length > 0) {
        const existing = await this.db.notification.findMany({
          where: { userId: { in: userIds }, type: NotificationType.AnnouncementPublished, data: { path: ["target", "id"], equals: announcement.id } },
          select: { userId: true },
        });
        const already = new Set(existing.map((item) => item.userId));
        const pending = userIds.filter((id) => !already.has(id));
        await this.db.$transaction(async (tx) => {
          for (const userId of pending) {
            const notification = await tx.notification.create({
              data: {
                userId,
                category: announcement.audience === AnnouncementAudience.COURSE ? NotificationCategory.ACADEMIC : NotificationCategory.ADMINISTRATIVE,
                type: NotificationType.AnnouncementPublished,
                institutionId: announcement.institutionId,
                data: { params: { title: announcement.title, context }, target: { kind: "announcement", id: announcement.id, parentId: announcement.courseId ?? announcement.institutionId } },
              },
              select: { id: true },
            });
            await this.outbox.enqueue(tx, { type: NOTIFICATION_DELIVER_EVENT, aggregateType: "notification", aggregateId: notification.id, payload: { notificationId: notification.id }, requestId });
          }
        });
        total += pending.length;
      }
      if (recipients.length < FANOUT_BATCH) break;
      cursor = recipients[recipients.length - 1]!.userId;
    }
    return total;
  }
}
