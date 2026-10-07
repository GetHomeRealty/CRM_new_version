ALTER TABLE "leads" ADD COLUMN "collaborator_user_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
CREATE INDEX "leads_collaborator_user_ids_idx" ON "leads" USING GIN ("collaborator_user_ids");
