-- TD-076 — telling a double-click apart from a genuine duplicate.
--
-- Two identical creates arriving together used to answer 500. The advisory lock added earlier
-- closed that race, and the loser now gets the SAME 422 the sequential path gives: "Transaction
-- already exists — Trade #NNN". The brokerage rejected that on the user's behalf, and correctly:
-- a double-click is ONE submission that arrived twice, the user's deal DID save, and telling them
-- it already exists implies somebody else created it or that theirs failed. They then go looking
-- for a record they believe is not theirs — wrong rather than merely unhelpful.
--
-- The two situations cannot be told apart by timing, which is guesswork, so the form mints a token
-- when it opens and both clicks carry it. A second create bearing a token this table already holds
-- is a replay: the deal it created is returned and nothing is reported. A genuinely new attempt
-- later carries a different token and still meets the duplicate guard and its 422.
--
-- NULLABLE, and unique only among non-null values, which is what Postgres does with NULLs in a
-- unique index. Every existing row keeps null, and any client that sends no token — the importer,
-- the API, anything older than this column — behaves exactly as it does today.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "client_token" VARCHAR(64);

-- Unique so the replay check cannot race itself: two simultaneous creates carrying one token
-- cannot both insert, whatever the application does.
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_client_token_key" ON "transactions"("client_token");
