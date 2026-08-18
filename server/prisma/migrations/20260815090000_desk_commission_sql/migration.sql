-- Transaction Desk: commission arithmetic the database can do, and the two indexes the list
-- screens sort by.
--
-- WHY THESE FUNCTIONS EXIST AT ALL. Analytics and the Dashboard summed commission over every deal
-- in the brokerage in Node — measured at 80,000 deals: Analytics 3.1 s single user and a 33 s p95
-- under a hundred concurrent, Dashboard commissions 9.6 s and 62.7 s. Neither figure improves with
-- a faster database, because the cost is not the query: it is fetching every row and doing the
-- arithmetic one deal at a time in JavaScript. Moving the arithmetic to where the rows already are
-- is the only change that alters the shape of the curve.
--
-- WHY THEY ARE WRITTEN THIS WAY. Money that is already displayed must not move by a cent, so these
-- are not "an equivalent formula" — they are a transliteration of `CommissionService.grossCommission`
-- and `common/serialize.ts:phpRound`, operation for operation, in `double precision`, which is the
-- same IEEE-754 binary64 JavaScript numbers are. Same order of operations, same intermediate
-- rounding, same treatment of NULL. `core/desk-sql-parity.spec.ts` runs both implementations over
-- every transaction in the database and requires EXACT equality, so a future edit to one that is
-- not made to the other fails a test rather than quietly changing somebody's commission.

-- ---------------------------------------------------------------------------
-- PHP round($v, 2) — round half AWAY FROM ZERO, with PHP's floating-point pre-correction.
--
-- The pre-correction is the part that looks superstitious and is not: PHP (and therefore this
-- application, everywhere, via `phpRound`) re-reads the scaled value at 14 significant digits
-- before rounding, so that round(2.005, 2) is 2.01 rather than 2.00 — 2.005 is really
-- 2.00499999999999989 in binary and would otherwise round down. `toPrecision(14)` in JavaScript and
-- `round to 14 significant digits` here are the same operation.
--
-- Returns NUMERIC, not double precision, and that is deliberate. The value is exactly two decimal
-- places by construction, and returning it as an exact decimal means the SUM() over it is exact and
-- INDEPENDENT OF ROW ORDER. Summing doubles is neither: floating-point addition is not associative,
-- so a parallel or hash aggregate could return a different last cent from one run to the next.
CREATE OR REPLACE FUNCTION php_round2(v double precision)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    -- NaN and the infinities have no two-decimal value. `phpRound` returns them unchanged; nothing
    -- downstream can sum them, so they become NULL here rather than poisoning an aggregate.
    WHEN v IS NULL OR v <> v OR v = 'Infinity'::float8 OR v = '-Infinity'::float8 THEN NULL
    ELSE (CASE WHEN v < 0 THEN -1 ELSE 1 END)
       * round(
           CASE
             WHEN abs(v) * 100 = 0 THEN 0::numeric
             ELSE round(
               (abs(v) * 100)::numeric,
               -- 14 significant digits: 13 places after the leading digit.
               GREATEST(0, 13 - floor(log((abs(v) * 100)::numeric))::int)
             )
           END
         )
       / 100
  END;
$$;

COMMENT ON FUNCTION php_round2(double precision) IS
  'PHP round($v, 2): half away from zero with 14-significant-digit pre-correction. Transliteration of common/serialize.ts:phpRound. Guarded by core/desk-sql-parity.spec.ts.';

-- ---------------------------------------------------------------------------
-- The gross commission on one deal, before HST — `CommissionService.grossCommission`.
--
-- Three variants, tested in the same order the TypeScript tests them, because the order is the
-- rule: a Preconstruction deal never reaches the listing branch, and a listing deal never reaches
-- the four-way fallback, however its comm_pct is set.
--
-- The four-way fallback at the end reads as redundant and is not. `comm_amt` wins over `comm_pct`,
-- which wins over `comm_value` interpreted by `comm_type`; each test is `IS NOT NULL AND > 0`, so a
-- stored zero falls through to the next rather than short-circuiting to nothing. That is what the
-- application does and what the figures on every screen already reflect.
CREATE OR REPLACE FUNCTION desk_gross_commission(
  p_type                   text,
  p_price                  double precision,
  p_comm_type              text,
  p_comm_value             double precision,
  p_comm_pct               double precision,
  p_comm_amt               double precision,
  p_listing_comm_pct       double precision,
  p_coop_comm_pct          double precision,
  p_listing_comm_flat      double precision,
  p_coop_comm_flat         double precision,
  p_precon_comm_pct        double precision,
  p_precon_comm_amt_manual double precision
)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    -- Preconstruction: a manually entered amount, else the master percentage of the price.
    WHEN p_type = 'Preconstruction' THEN
      CASE
        WHEN p_precon_comm_amt_manual IS NOT NULL AND p_precon_comm_amt_manual > 0
          THEN p_precon_comm_amt_manual
        ELSE (p_price * COALESCE(p_precon_comm_pct, 0)) / 100
      END

    -- Listing side (and Business Sale): the listing leg plus the co-operating leg, each a
    -- percentage of the price plus a flat amount.
    WHEN p_type IN (
      'Residential Sale Listing',
      'Residential Lease Listing',
      'Commercial Property Sale Listing',
      'Commercial Property Lease Listing',
      'Business Sale'
    ) THEN
      ((p_price * COALESCE(p_listing_comm_pct, 0)) / 100 + COALESCE(p_listing_comm_flat, 0))
      + ((p_price * COALESCE(p_coop_comm_pct, 0)) / 100 + COALESCE(p_coop_comm_flat, 0))

    -- Everything else: amount, then percentage, then the comm_type/comm_value pair.
    WHEN p_comm_amt IS NOT NULL AND p_comm_amt > 0 THEN p_comm_amt
    WHEN p_comm_pct IS NOT NULL AND p_comm_pct > 0 THEN (p_price * p_comm_pct) / 100
    WHEN p_comm_type = '%' AND p_comm_value > 0 THEN (p_price * p_comm_value) / 100
    WHEN p_comm_type = 'Fixed' AND p_comm_value > 0 THEN p_comm_value
    ELSE 0
  END;
$$;

COMMENT ON FUNCTION desk_gross_commission(text, double precision, text, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision) IS
  'Gross commission before HST. Transliteration of CommissionService.grossCommission. Guarded by core/desk-sql-parity.spec.ts.';

-- ---------------------------------------------------------------------------
-- The two list screens both sort newest-first over the live rows, and neither had an index for it.
--
-- Without these the planner reads the whole table and sorts it to answer page 1 of 3,200 — measured
-- on the transactions list at 80,000 deals, that sort is most of the request. The leading
-- `deleted_at` column is what makes them usable: every list query says `deleted_at IS NULL`, so the
-- index is scanned in order and the executor stops as soon as it has the page.
CREATE INDEX IF NOT EXISTS transactions_live_recent_idx
  ON transactions (deleted_at, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS invoices_live_recent_idx
  ON invoices (deleted_at, created_at DESC, id ASC);
