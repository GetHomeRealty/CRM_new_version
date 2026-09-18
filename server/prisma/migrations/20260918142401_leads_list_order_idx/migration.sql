-- CreateIndex
CREATE INDEX "leads_list_order_idx" ON "leads"("deleted_at", "updated_at" DESC, "created_at" DESC, "id" DESC);

