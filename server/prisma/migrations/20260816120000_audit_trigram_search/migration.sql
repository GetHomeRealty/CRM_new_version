-- Audit Trail text search, indexed.
--
-- WHY. `AuditLogService.index` searches seven text columns with `contains` — seven `ILIKE '%term%'`
-- clauses ORed together. No index can serve a leading-wildcard LIKE, so every search read the whole
-- table. Measured on 2,460,000 audit rows: 1.8 s to 2.5 s per search, whatever the term.
--
-- Trigram indexes can serve `LIKE '%x%'` and `ILIKE '%x%'`: `pg_trgm` breaks each value into
-- three-character sequences and indexes those, so a pattern of three characters or more becomes a
-- lookup instead of a scan. MEASURED, same corpus, best of three:
--
--     a term that matches nothing        2,537 ms  ->      2 ms
--     "2.5"                              1,783 ms  ->    169 ms
--     "Commission" (400,000 matches)     2,257 ms  ->  1,794 ms
--
-- The last one barely moves and that is expected rather than disappointing: a term matching four
-- hundred thousand rows has to count four hundred thousand rows, and no index changes that. What the
-- index fixes is the ordinary case — a name, a trade number, a field value — which was paying the
-- price of the worst case.
--
-- THE TRADE-OFF, STATED PLAINLY. A pattern SHORTER THAN THREE CHARACTERS has no complete trigram, so
-- the index cannot narrow it; the planner uses it anyway and then rechecks every row it returns.
-- Measured: a two-character search went from about 2.5 s to 6.2 s. One- and two-character searches
-- of an audit trail match almost everything and are not a useful query — a single letter matched
-- 2,040,000 of the 2,460,000 rows here — but they ARE slower than before, and that is a real cost of
-- this change rather than a rounding error.
--
-- COST ON DISK AND ON WRITES. 137 MB of index against a 292 MB table, and `audit_logs` is the table
-- that grows without bound. Every audit row now maintains seven GIN indexes on insert; GIN buffers
-- that work in its pending list, so the cost lands on autovacuum rather than on the writer, but it is
-- not free. If the audit trail is retained for years without partitioning, this is the first thing to
-- reconsider.
--
-- BUILD TIME: 17 seconds for 2.46 million rows, holding a write lock on `audit_logs` for the
-- duration. Not CONCURRENTLY, because Prisma runs each migration inside a transaction and
-- CREATE INDEX CONCURRENTLY cannot run in one. On a busy production database, build these by hand
-- with CONCURRENTLY first and this migration then finds them already present.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- One index per searched column rather than one over a concatenation of them. The query is an OR of
-- seven independent predicates, which PostgreSQL answers with a BitmapOr across seven indexes;
-- concatenating instead would let a term match ACROSS a column boundary — a search for "AliceOffer"
-- finding a row whose `who` ends in "Alice" and whose `section` begins with "Offer" — which is a
-- different search from the one the user asked for.
CREATE INDEX IF NOT EXISTS audit_logs_who_trgm_idx       ON audit_logs USING gin (who gin_trgm_ops);
CREATE INDEX IF NOT EXISTS audit_logs_section_trgm_idx   ON audit_logs USING gin (section gin_trgm_ops);
CREATE INDEX IF NOT EXISTS audit_logs_field_trgm_idx     ON audit_logs USING gin (field gin_trgm_ops);
CREATE INDEX IF NOT EXISTS audit_logs_old_value_trgm_idx ON audit_logs USING gin (old_value gin_trgm_ops);
CREATE INDEX IF NOT EXISTS audit_logs_new_value_trgm_idx ON audit_logs USING gin (new_value gin_trgm_ops);
CREATE INDEX IF NOT EXISTS audit_logs_action_trgm_idx    ON audit_logs USING gin (action gin_trgm_ops);
CREATE INDEX IF NOT EXISTS audit_logs_details_trgm_idx   ON audit_logs USING gin (details gin_trgm_ops);
