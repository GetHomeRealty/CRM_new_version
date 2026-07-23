-- Todo list shown on the Calendar screen. A todo has no time slot, so it is its own table
-- rather than a calendar_event with a fake time.

CREATE TABLE IF NOT EXISTS "todos" (
  "id"           SERIAL       PRIMARY KEY,
  "title"        VARCHAR(255) NOT NULL,
  "description"  TEXT,
  "status"       VARCHAR(16)  NOT NULL DEFAULT 'pending',
  "priority"     VARCHAR(16)  NOT NULL DEFAULT 'medium',
  "due_date"     DATE,
  "completed_at" TIMESTAMP(0),
  "user_id"      INTEGER,
  "created_by"   VARCHAR(255),
  "created_at"   TIMESTAMP(0),
  "updated_at"   TIMESTAMP(0),
  "deleted_at"   TIMESTAMP(0)
);

CREATE INDEX IF NOT EXISTS "todos_status_idx"     ON "todos"("status");
CREATE INDEX IF NOT EXISTS "todos_user_id_idx"    ON "todos"("user_id");
CREATE INDEX IF NOT EXISTS "todos_due_date_idx"   ON "todos"("due_date");
CREATE INDEX IF NOT EXISTS "todos_deleted_at_idx" ON "todos"("deleted_at");
