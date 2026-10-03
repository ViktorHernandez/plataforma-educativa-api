import { registerAssessmentRoutes } from "../modules/assessments/assessment.routes.js";
import { registerAdminRoutes } from "../modules/admin/admin.routes.js";
import { registerFileRoutes } from "../modules/files/file.routes.js";
import { registerMessagingRoutes } from "../modules/messaging/messaging.routes.js";
import { registerAnnouncementRoutes } from "../modules/notifications/announcement.routes.js";
import { registerWebhookRoutes } from "../modules/webhooks/webhook.routes.js";
import { registerCourseRoutes } from "../modules/courses/course.routes.js";
import { registerEnrollmentRoutes } from "../modules/enrollments/enrollment.routes.js";
import { registerInstitutionRoutes } from "../modules/institutions/institution.routes.js";
import { registerNotificationRoutes } from "../modules/notifications/notification.routes.js";
import { registerUserRoutes } from "../modules/users/user.routes.js";
import { registerCalendarRoutes } from "../modules/integrations/calendar.routes.js";
import { registerPrivacyRoutes } from "../modules/privacy/privacy.routes.js";
import { registerSecurityRoutes } from "../modules/security/security.routes.js";
import type { Container } from "./container.js";
import type { AppInstance } from "./types.js";

export function registerModuleRoutes(app: AppInstance, container: Container): void {
  registerUserRoutes(app, container);
  registerNotificationRoutes(app, container);
  registerInstitutionRoutes(app, container);
  registerCourseRoutes(app, container);
  registerEnrollmentRoutes(app, container);
  registerAssessmentRoutes(app, container);
  registerFileRoutes(app, container);
  registerMessagingRoutes(app, container);
  registerAnnouncementRoutes(app, container);
  registerAdminRoutes(app, container);
  registerWebhookRoutes(app, container);
  registerPrivacyRoutes(app, container);
  registerSecurityRoutes(app, container);
  registerCalendarRoutes(app, container);
}
