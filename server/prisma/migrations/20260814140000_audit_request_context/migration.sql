-- Where an audited action came from.
--
-- WHY. The trail answers who, what and when. It could not answer "from where", and that is the
-- question asked about exactly the entries somebody eventually has to defend: a commission figure
-- changed, a transaction permanently deleted, a Super Admin overriding a lock, an invoice payment
-- adjusted. Reconstructing it afterwards from the web server's access log is not possible — the
-- access log has no idea which audit row a given request produced.
--
-- `request_id` is the id the structured logger stamps on every line and the API returns in the
-- `X-Request-Id` header, so an audit row is joinable to the full log of the request that wrote it.
--
-- ADDITIVE AND BACKWARD-COMPATIBLE, which matters because `audit_logs` is shared with the CRM:
--   * three NULLABLE columns — every existing row stays valid and no backfill is possible or wanted
--     (the information never existed for them);
--   * no existing query, filter, response field or export column changes;
--   * they are written centrally by AuditService from the request context, so CRM entries gain the
--     same context without any CRM code changing;
--   * background work (the reminder sweeps, the review SLA ladder) has no request and correctly
--     records NULL rather than something invented.
--
-- Sizes: 45 characters holds an IPv4-mapped IPv6 address in full; user agents are clipped to 255 in
-- the interceptor because a header is attacker-controlled length.

ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "ip"         VARCHAR(45);
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "user_agent" VARCHAR(255);
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "request_id" VARCHAR(64);
