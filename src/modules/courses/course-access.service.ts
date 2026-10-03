import type { AuthorizationService } from "../../core/authz/authorization-service.js";
import { Permission } from "../../core/authz/permissions.js";
import type { Database } from "../../core/database/prisma.js";
import { AppError, ErrorCode, notFound } from "../../core/http/errors.js";
import type { Course, Lesson } from "../../generated/prisma/client.js";
import { ContentStatus, CourseStatus, CourseVisibility, EnrollmentStatus, InstitutionStatus, MembershipStatus } from "../../generated/prisma/enums.js";

export type CourseRecord = Course;

const learnerStatuses: EnrollmentStatus[] = [EnrollmentStatus.ACTIVE, EnrollmentStatus.COMPLETED];

export class CourseAccessService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthorizationService,
  ) {}

  async findCourse(courseId: string): Promise<CourseRecord> {
    const course = await this.db.course.findFirst({ where: { id: courseId, deletedAt: null } });
    if (!course) throw notFound("Course");
    return course;
  }

  scopeOf(course: Pick<Course, "id" | "institutionId">) {
    return { institutionId: course.institutionId, courseId: course.id };
  }

  async can(userId: string, permission: Permission, course: Pick<Course, "id" | "institutionId">): Promise<boolean> {
    return this.authz.can(userId, permission, this.scopeOf(course));
  }

  async requireManage(userId: string, courseId: string, permission: Permission): Promise<CourseRecord> {
    const course = await this.findCourse(courseId);
    if (await this.can(userId, permission, course)) return course;
    if (await this.can(userId, Permission.CourseRead, course)) throw new AppError(403, ErrorCode.FORBIDDEN, "You do not have permission to perform this action");
    throw notFound("Course");
  }

  async isInstitutionMember(userId: string, institutionId: string): Promise<boolean> {
    const membership = await this.db.institutionMembership.findUnique({
      where: { institutionId_userId: { institutionId, userId } },
      select: { status: true, institution: { select: { status: true } } },
    });
    return membership?.status === MembershipStatus.ACTIVE && membership.institution.status === InstitutionStatus.ACTIVE;
  }

  async canSeeInCatalog(userId: string | null, course: CourseRecord): Promise<boolean> {
    if (userId && (await this.can(userId, Permission.CourseRead, course))) return true;
    if (course.status !== CourseStatus.PUBLISHED) {
      if (!userId || course.status !== CourseStatus.ARCHIVED) return false;
      return (await this.learnerEnrollment(userId, course.id)) !== null;
    }
    switch (course.visibility) {
      case CourseVisibility.PUBLIC:
      case CourseVisibility.UNLISTED:
        return true;
      case CourseVisibility.INSTITUTION:
        return userId !== null && (await this.isInstitutionMember(userId, course.institutionId));
      default:
        return userId !== null && (await this.learnerEnrollment(userId, course.id)) !== null;
    }
  }

  async requireVisible(userId: string | null, courseId: string): Promise<CourseRecord> {
    const course = await this.findCourse(courseId);
    if (!(await this.canSeeInCatalog(userId, course))) throw notFound("Course");
    return course;
  }

  async learnerEnrollment(userId: string, courseId: string) {
    const enrollment = await this.db.enrollment.findUnique({ where: { userId_courseId: { userId, courseId } } });
    return enrollment && learnerStatuses.includes(enrollment.status) ? enrollment : null;
  }

  async requireLessonAccess(userId: string | null, lessonId: string): Promise<{ lesson: Lesson; course: CourseRecord; staff: boolean; enrollmentId: string | null }> {
    const lesson = await this.db.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson) throw notFound("Lesson");
    const course = await this.findCourse(lesson.courseId);
    if (userId && (await this.can(userId, Permission.CourseRead, course))) {
      return { lesson, course, staff: true, enrollmentId: null };
    }
    if (lesson.status !== ContentStatus.PUBLISHED || !(await this.canSeeInCatalog(userId, course))) throw notFound("Lesson");
    if (userId) {
      const enrollment = await this.learnerEnrollment(userId, course.id);
      if (enrollment) return { lesson, course, staff: false, enrollmentId: enrollment.id };
    }
    if (lesson.isPreview && course.status === CourseStatus.PUBLISHED) return { lesson, course, staff: false, enrollmentId: null };
    throw new AppError(403, ErrorCode.NOT_ENROLLED, "Active enrollment required");
  }
}
