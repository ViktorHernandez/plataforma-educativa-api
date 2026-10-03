import { RoleScope } from "../../generated/prisma/enums.js";

export const Permission = {
  PlatformSettingsManage: "platform.settings.manage",
  InstitutionCreate: "institution.create",
  InstitutionRead: "institution.read",
  InstitutionUpdate: "institution.update",
  InstitutionMembersRead: "institution.members.read",
  InstitutionMembersManage: "institution.members.manage",
  RoleRead: "role.read",
  RoleAssign: "role.assign",
  UserRead: "user.read",
  UserManage: "user.manage",
  UserSessionsRevoke: "user.sessions.revoke",
  AuditRead: "audit.read",
  ReportRead: "report.read",
  ReportExport: "report.export",
  CategoryManage: "category.manage",
  ProgramCreate: "program.create",
  ProgramUpdate: "program.update",
  ProgramRead: "program.read",
  CourseCreate: "course.create",
  CourseRead: "course.read",
  CourseUpdate: "course.update",
  CoursePublish: "course.publish",
  CourseDelete: "course.delete",
  CourseStaffManage: "course.staff.manage",
  EnrollmentRead: "enrollment.read",
  EnrollmentManage: "enrollment.manage",
  ProgressRead: "progress.read",
  QuestionBankRead: "question_bank.read",
  QuestionBankManage: "question_bank.manage",
  AssessmentRead: "assessment.read",
  AssessmentManage: "assessment.manage",
  AssessmentGrade: "assessment.grade",
  AnnouncementCreate: "announcement.create",
  MessagingModerate: "messaging.moderate",
  CertificateManage: "certificate.manage",
  ClassGroupManage: "class_group.manage",
  PrivacyManage: "privacy.manage",
  SecurityKeysManage: "security.keys.manage",
  AssessmentAccommodate: "assessment.accommodate",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const allPermissions: Permission[] = Object.values(Permission);

const institutionAdministration: Permission[] = [
  Permission.InstitutionRead,
  Permission.InstitutionUpdate,
  Permission.InstitutionMembersRead,
  Permission.InstitutionMembersManage,
  Permission.RoleRead,
  Permission.RoleAssign,
  Permission.AuditRead,
  Permission.ReportRead,
  Permission.ReportExport,
  Permission.CategoryManage,
  Permission.ProgramCreate,
  Permission.ProgramUpdate,
  Permission.ProgramRead,
  Permission.CourseCreate,
  Permission.CourseRead,
  Permission.CourseUpdate,
  Permission.CoursePublish,
  Permission.CourseDelete,
  Permission.CourseStaffManage,
  Permission.EnrollmentRead,
  Permission.EnrollmentManage,
  Permission.ProgressRead,
  Permission.QuestionBankRead,
  Permission.QuestionBankManage,
  Permission.AssessmentRead,
  Permission.AssessmentManage,
  Permission.AssessmentGrade,
  Permission.AnnouncementCreate,
  Permission.MessagingModerate,
  Permission.CertificateManage,
  Permission.ClassGroupManage,
  Permission.AssessmentAccommodate,
];

export interface SystemRoleDefinition {
  key: string;
  name: string;
  description: string;
  scope: RoleScope;
  permissions: Permission[];
}

export const SystemRole = {
  PlatformAdmin: "platform_admin",
  PlatformSupport: "platform_support",
  InstitutionAdmin: "institution_admin",
  Teacher: "teacher",
  Student: "student",
  CourseInstructor: "course_instructor",
  CourseAssistant: "course_assistant",
} as const;

export type SystemRoleKey = (typeof SystemRole)[keyof typeof SystemRole];

export const systemRoles: SystemRoleDefinition[] = [
  {
    key: SystemRole.PlatformAdmin,
    name: "Platform administrator",
    description: "Full control over the platform",
    scope: RoleScope.PLATFORM,
    permissions: allPermissions,
  },
  {
    key: SystemRole.PlatformSupport,
    name: "Platform support",
    description: "Read access for support and incident response",
    scope: RoleScope.PLATFORM,
    permissions: [
      Permission.InstitutionRead,
      Permission.InstitutionMembersRead,
      Permission.UserRead,
      Permission.UserSessionsRevoke,
      Permission.AuditRead,
      Permission.EnrollmentRead,
      Permission.CourseRead,
      Permission.RoleRead,
    ],
  },
  {
    key: SystemRole.InstitutionAdmin,
    name: "Institution administrator",
    description: "Manages an institution, its members, courses and reports",
    scope: RoleScope.INSTITUTION,
    permissions: institutionAdministration,
  },
  {
    key: SystemRole.Teacher,
    name: "Teacher",
    description: "Creates and teaches courses inside an institution",
    scope: RoleScope.INSTITUTION,
    permissions: [
      Permission.InstitutionRead,
      Permission.CourseCreate,
      Permission.ProgramRead,
      Permission.QuestionBankRead,
      Permission.QuestionBankManage,
      Permission.AnnouncementCreate,
    ],
  },
  {
    key: SystemRole.Student,
    name: "Student",
    description: "Learner member of an institution",
    scope: RoleScope.INSTITUTION,
    permissions: [],
  },
  {
    key: SystemRole.CourseInstructor,
    name: "Course instructor",
    description: "Owns the content, learners and grading of a course",
    scope: RoleScope.COURSE,
    permissions: [
      Permission.CourseRead,
      Permission.CourseUpdate,
      Permission.CoursePublish,
      Permission.CourseStaffManage,
      Permission.EnrollmentRead,
      Permission.EnrollmentManage,
      Permission.ProgressRead,
      Permission.QuestionBankRead,
      Permission.QuestionBankManage,
      Permission.AssessmentRead,
      Permission.AssessmentManage,
      Permission.AssessmentGrade,
      Permission.AssessmentAccommodate,
      Permission.AnnouncementCreate,
      Permission.ReportRead,
      Permission.ReportExport,
      Permission.MessagingModerate,
    ],
  },
  {
    key: SystemRole.CourseAssistant,
    name: "Course assistant",
    description: "Supports instructors with learners and grading",
    scope: RoleScope.COURSE,
    permissions: [
      Permission.CourseRead,
      Permission.EnrollmentRead,
      Permission.ProgressRead,
      Permission.AssessmentRead,
      Permission.AssessmentGrade,
      Permission.AnnouncementCreate,
      Permission.ReportRead,
    ],
  },
];

export function isKnownPermission(value: string): value is Permission {
  return (allPermissions as string[]).includes(value);
}
