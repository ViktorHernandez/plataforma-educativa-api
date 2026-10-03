CREATE INDEX "courses_coverFileId_idx" ON "courses"("coverFileId");

CREATE INDEX "lesson_progress_courseId_idx" ON "lesson_progress"("courseId");

CREATE INDEX "lesson_resources_fileId_idx" ON "lesson_resources"("fileId");

CREATE INDEX "lessons_mediaFileId_idx" ON "lessons"("mediaFileId");

CREATE INDEX "media_tracks_trackFileId_idx" ON "media_tracks"("trackFileId");

CREATE INDEX "message_attachments_fileId_idx" ON "message_attachments"("fileId");

CREATE INDEX "messages_senderId_idx" ON "messages"("senderId");

CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");
