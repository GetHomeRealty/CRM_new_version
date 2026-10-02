-- The Team Lead level of a lead's assignment: Admin -> Team Lead -> Agent.
--
-- An Admin hands a brokerage lead to a Team Lead the existing way (`assigned_to` = the Team Lead,
-- from the lead editor or Lead books). When that Team Lead passes it to one of their Agents,
-- `assigned_to` becomes the Agent — and without this column nothing would remember that the lead
-- reached the Agent THROUGH that Team Lead, so the Team Lead could neither see it nor reassign it.
--
-- `assigned_team_lead_id` is that memory. It is written only by the Team Lead's own assignment
-- (server/src/dashboard/team-lead-leads.service.ts) and never changes ownership: the owner stays the
-- brokerage (owner_user_id NULL) or whoever it was.
--
-- A plain integer with an index, like `owner_user_id` and `assigned_to` beside it — the leads
-- table holds its user references without foreign keys.
--
-- ADDITIVE AND INERT ON DAY ONE: every existing row gets NULL, so no lead's visibility changes.
-- IDEMPOTENT, like the recent migrations.

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "assigned_team_lead_id" INTEGER;
CREATE INDEX IF NOT EXISTS "leads_assigned_team_lead_id_idx" ON "leads"("assigned_team_lead_id");
