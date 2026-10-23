-- LET THE APPLICATION USE payment_sheet_rows (follow-up to 20261019120000_payment_sheet_rows).
--
-- Migrations here run as the owner (postgres, scripts/apply-migrations.sh) while the application
-- connects as its own user, so a new table is unreadable to the app until access is granted: the
-- gate refused the first deploy with "permission denied for table payment_sheet_rows".
--
-- GRANTED TO EXACTLY WHOEVER CAN ALREADY USE THE DEALS TABLE, rather than to a role named here: the
-- live database and the gate's test database need not connect as the same user, and nobody gains
-- access they did not already have to the brokerage's payments. The table's owner is included when
-- it is not postgres. Re-running it changes nothing.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT grantee AS role FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'transactions' AND privilege_type = 'SELECT'
       AND grantee NOT IN ('postgres', 'PUBLIC')
    UNION
    SELECT tableowner FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'transactions' AND tableowner <> 'postgres'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_sheet_rows TO %I', r.role);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.payment_sheet_rows_id_seq TO %I', r.role);
  END LOOP;
END $$;
