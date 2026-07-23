-- Campaign email templates — the Campaigns module's own template library.
--
-- Kept separate from `email_templates` (Email Settings), which drives transactional mail keyed
-- by event_key. Editing a campaign template must never change a transactional one.

CREATE TABLE IF NOT EXISTS "campaign_templates" (
  "id"         SERIAL       PRIMARY KEY,
  "name"       VARCHAR(255) NOT NULL,
  "subject"    VARCHAR(500) NOT NULL,
  "content"    TEXT         NOT NULL,
  "category"   VARCHAR(32)  NOT NULL DEFAULT 'custom',
  "is_active"  BOOLEAN      NOT NULL DEFAULT true,
  "created_by" VARCHAR(255),
  "user_id"    INTEGER,
  "created_at" TIMESTAMP(0),
  "updated_at" TIMESTAMP(0),
  "deleted_at" TIMESTAMP(0)
);
CREATE INDEX IF NOT EXISTS "campaign_templates_category_idx"   ON "campaign_templates"("category");
CREATE INDEX IF NOT EXISTS "campaign_templates_deleted_at_idx" ON "campaign_templates"("deleted_at");

CREATE TABLE IF NOT EXISTS "campaign_template_attachments" (
  "id"           SERIAL       PRIMARY KEY,
  "template_id"  INTEGER      NOT NULL,
  "filename"     VARCHAR(255) NOT NULL,
  "content_type" VARCHAR(128) NOT NULL,
  "size"         INTEGER      NOT NULL,
  "data"         BYTEA        NOT NULL,
  "created_at"   TIMESTAMP(0),
  CONSTRAINT "campaign_template_attachments_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "campaign_templates"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "campaign_template_attachments_template_id_idx"
  ON "campaign_template_attachments"("template_id");
