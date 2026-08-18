-- php_round2: the same answer, roughly forty times faster.
--
-- WHY. The Dashboard's commission aggregate calls this about half a million times per run — once per
-- deal for the gross, twice per agent line, twice per preconstruction term. Measured at 16 µs a call
-- it was 8 of the aggregate's 14 seconds, and micro-benchmarked against plain arithmetic (113 ms for
-- 500,000 calls) it was seventy times the cost of the multiplication it wraps.
--
-- All of that went on `numeric`: two casts, a base-10 `log` and two `round`s, per call, to reproduce
-- PHP's 14-significant-digit pre-correction before rounding half away from zero.
--
-- WHAT CHANGED, AND WHY THE ANSWER CANNOT. The pre-correction exists for ONE situation: a value that
-- lands within floating-point noise of a half-cent boundary, where the binary representation sits a
-- hair below the decimal it prints as. `round(2.005, 2)` is the canonical case — 2.005 is really
-- 2.00499999999999989, and rounding it directly gives 2.00 where PHP gives 2.01.
--
-- Everywhere else the pre-correction changes nothing: re-reading a value at 14 significant digits
-- moves it by at most about 5e-14 relative, which cannot carry it across a .5 boundary it was not
-- already sitting on.
--
-- So this asks that question first, in float arithmetic, and only pays for `numeric` when the answer
-- is "yes, this one is near the boundary". The guard is deliberately generous — a thousand times
-- wider than the error it is bounding — so a value that MIGHT be affected takes the exact path. Being
-- generous costs a few more slow calls; being tight would silently change somebody's commission.
--
-- Guarded, as before, by core/desk-sql-parity.spec.ts, which compares this against
-- common/serialize.ts:phpRound over every transaction in the database and requires exact equality.
-- It was additionally re-run over all 79,037 deals of the 80,000-deal performance corpus after this
-- change: zero rows differed, and both brokerage-wide totals matched to the cent.
CREATE OR REPLACE FUNCTION php_round2(v double precision)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN v IS NULL OR v <> v OR v = 'Infinity'::float8 OR v = '-Infinity'::float8 THEN NULL
    ELSE (CASE WHEN v < 0 THEN -1 ELSE 1 END)::numeric * (
      CASE
        /*
         * FAST PATH — not near a half-cent boundary, so the pre-correction is a no-op.
         *
         * Two conditions, both required:
         *   · the scaled value is below 2^52, so `+ 0.5` is still exact in binary64 and
         *     `floor(y + 0.5)` is exactly Math.round(y) for a non-negative y;
         *   · it is further from the .5 boundary than 1e-13 of itself (plus an absolute floor for
         *     values near zero) — three orders of magnitude more room than the 5e-14 the
         *     14-digit re-read could move it.
         */
        WHEN abs(v) * 100 < 4503599627370496::float8
         AND abs(abs(v) * 100 - floor(abs(v) * 100) - 0.5::float8)
             > abs(v) * 100 * 1e-13::float8 + 1e-9::float8
          THEN floor(abs(v) * 100 + 0.5::float8)::numeric

        /* SLOW PATH — byte for byte what this function did before. */
        WHEN abs(v) * 100 = 0 THEN 0::numeric
        ELSE round(round(
          (abs(v) * 100)::numeric,
          GREATEST(0, 13 - floor(log((abs(v) * 100)::numeric))::int)
        ))
      END
    ) / 100
  END;
$$;

COMMENT ON FUNCTION php_round2(double precision) IS
  'PHP round($v, 2): half away from zero with 14-significant-digit pre-correction. Transliteration of common/serialize.ts:phpRound, with a float fast path for values away from a half-cent boundary. Guarded by core/desk-sql-parity.spec.ts.';
