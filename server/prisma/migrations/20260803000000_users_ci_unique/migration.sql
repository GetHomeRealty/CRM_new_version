-- Case-insensitive uniqueness for email and username.
--
-- The columns already carry plain UNIQUE indexes, which are case-SENSITIVE — so
-- priya@brokerage.ca and PRIYA@BROKERAGE.CA were two accounts. Confirmed at runtime: the uppercase
-- duplicate was accepted with a 201. Mail systems treat them as one person, so a password reset or
-- a notification could reach either, and the sign-in form authenticates whichever row matches the
-- case that was typed.
--
-- The service now compares case-insensitively, but a pre-check is a SELECT before an INSERT and two
-- requests can both pass it. These indexes are what actually decides, and the service translates
-- their violation into the same validation error.
--
-- GUARDED. If any database already holds case-variant duplicates this stops with the query that
-- lists them, rather than failing halfway through with a bare constraint error.
DO $$
DECLARE clash_count integer;
BEGIN
  SELECT count(*) INTO clash_count FROM (
    SELECT lower(email) FROM users GROUP BY lower(email) HAVING count(*) > 1
  ) dupes;
  IF clash_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add the case-insensitive email index: % address(es) differ only by capitalisation. List them with:  SELECT lower(email), count(*) FROM users GROUP BY lower(email) HAVING count(*) > 1;  Merge or rename them, then run this migration again.',
      clash_count;
  END IF;

  SELECT count(*) INTO clash_count FROM (
    SELECT lower(username) FROM users WHERE username IS NOT NULL GROUP BY lower(username) HAVING count(*) > 1
  ) dupes;
  IF clash_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add the case-insensitive username index: % username(s) differ only by capitalisation. List them with:  SELECT lower(username), count(*) FROM users WHERE username IS NOT NULL GROUP BY lower(username) HAVING count(*) > 1;',
      clash_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key" ON "users" (lower("email"));
-- Partial: username is nullable, and several accounts may legitimately have none.
CREATE UNIQUE INDEX IF NOT EXISTS "users_username_lower_key" ON "users" (lower("username")) WHERE "username" IS NOT NULL;
