-- D-1 correction: the first version led with deleted_at, which is a null test and cannot carry
-- the ordering, so the planner still sorted every filtered row. Ordering columns lead instead.
DROP INDEX "leads_list_order_idx";
CREATE INDEX "leads_list_order_idx" ON "leads"("updated_at" DESC, "created_at" DESC, "id" DESC);
