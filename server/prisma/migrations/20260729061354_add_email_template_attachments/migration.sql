-- CreateTable
CREATE TABLE "email_template_attachments" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(128) NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMP(0),

    CONSTRAINT "email_template_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_template_attachments_template_id_idx" ON "email_template_attachments"("template_id");

-- AddForeignKey
ALTER TABLE "email_template_attachments" ADD CONSTRAINT "email_template_attachments_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "email_templates"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
