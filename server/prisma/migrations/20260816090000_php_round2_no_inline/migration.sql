-- php_round2: stop the planner from inlining it, and give it a float-returning twin.
--
-- WHY. `php_round2` is a LANGUAGE sql function whose body is a single expression, so PostgreSQL
-- INLINES it — it substitutes the body into the caller and throws the function away. That is normally
-- what you want. Here it is the single most expensive thing in the commission aggregates, because the
-- body mentions its own argument SIX TIMES:
--
--     abs(v) * 100 < 2^52  AND  abs(abs(v)*100 - floor(abs(v)*100) - 0.5) > abs(v)*100 * 1e-13 …
--
-- Inlining copies the ARGUMENT EXPRESSION into every one of those places. The commission engine
-- rounds at each step, exactly as the TypeScript does, so the calls are nested:
--
--     php_round2(php_round2(php_round2(x)::float8 * a)::float8 * b)
--
-- and each level multiplies the one below it by six. Three levels deep, `x` is evaluated over two
-- hundred times to produce one number. Measured at 50,000 rows: 772 ms for a three-deep expression
-- against 95 ms for the same arithmetic in a function that is not inlined.
--
-- MEASURED IN THE REPORT ITSELF, at 80,000 deals: the standard variant of the report footer spent
-- 8.8 of its 10.0 seconds inside `std_lines`, which is twelve nested roundings per agent line.
--
-- WHAT CHANGES. Nothing about the arithmetic. Both functions below compute `abs(v) * 100` ONCE into a
-- local variable and then follow exactly the steps the SQL version followed — the same fast-path
-- guard, the same 14-significant-digit `numeric` pre-correction on the slow path, the same
-- half-away-from-zero rounding. Being PL/pgSQL is what stops the inlining; it is not a different
-- algorithm.
--
-- WHY A SECOND FUNCTION. Most call sites in the commission SQL are `php_round2(x)::float8`: the
-- TypeScript's `round2` returns a JavaScript number, so every intermediate step wants a float back.
-- The SQL version routes that through `numeric` and immediately casts it away again. `php_round2f`
-- returns `double precision` directly and is EXACTLY EQUAL to `php_round2(v)::float8` for every
-- input:
--
--   · on the fast path both compute `floor(abs(v)*100 + 0.5)`, an integer below 2^52 and therefore
--     exact in binary64. `numeric` division by 100 yields the exact two-decimal value and the cast to
--     float8 then rounds it to the nearest double; IEEE float division of the same integer by 100 is
--     also correctly rounded to the nearest double. Same value, both ways.
--   · on the slow path `php_round2f` DELEGATES to `php_round2` and casts, so there is nothing to
--     diverge.
--
-- Checked, not asserted: 636,160 values — every price in the 80,000-deal corpus, three commission
-- derivations of each, half-cent and third-cent ladders across ±20,000, 200,000 random magnitudes and
-- the boundary cases (0, ±2.005, ±0.615, 1e15, ±1e-9) — compared for exact equality. Zero differed.
--
-- The final aggregates keep `php_round2` and stay `numeric` on purpose: by then every value has been
-- rounded to two decimals, and summing as numeric is what makes the total independent of the order a
-- parallel aggregate adds them in. See the note at the top of dashboard/desk-commission.sql.ts.
--
-- Guarded, as before, by core/desk-sql-parity.spec.ts, which compares both against
-- common/serialize.ts:phpRound over every transaction in the database and requires exact equality.

CREATE OR REPLACE FUNCTION php_round2(v double precision)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  a double precision;
BEGIN
  IF v IS NULL OR v <> v OR v = 'Infinity'::float8 OR v = '-Infinity'::float8 THEN
    RETURN NULL;
  END IF;

  -- The argument, evaluated once. This local is the entire point of the rewrite.
  a := abs(v) * 100;

  -- FAST PATH — not near a half-cent boundary, so the pre-correction is a no-op.
  IF a < 4503599627370496::float8
     AND abs(a - floor(a) - 0.5::float8) > a * 1e-13::float8 + 1e-9::float8 THEN
    RETURN (CASE WHEN v < 0 THEN -1 ELSE 1 END)::numeric * floor(a + 0.5::float8)::numeric / 100;
  END IF;

  IF a = 0 THEN
    RETURN 0::numeric;
  END IF;

  -- SLOW PATH — byte for byte what this function has always done.
  RETURN (CASE WHEN v < 0 THEN -1 ELSE 1 END)::numeric
         * round(round(a::numeric, GREATEST(0, 13 - floor(log(a::numeric))::int)))
         / 100;
END
$$;

COMMENT ON FUNCTION php_round2(double precision) IS
  'PHP round($v, 2): half away from zero with 14-significant-digit pre-correction. Transliteration of common/serialize.ts:phpRound. PL/pgSQL so the planner cannot inline it — see migration 20260816090000. Guarded by core/desk-sql-parity.spec.ts.';

CREATE OR REPLACE FUNCTION php_round2f(v double precision)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  a double precision;
BEGIN
  IF v IS NULL OR v <> v OR v = 'Infinity'::float8 OR v = '-Infinity'::float8 THEN
    RETURN NULL;
  END IF;

  a := abs(v) * 100;

  IF a < 4503599627370496::float8
     AND abs(a - floor(a) - 0.5::float8) > a * 1e-13::float8 + 1e-9::float8 THEN
    RETURN (CASE WHEN v < 0 THEN -1 ELSE 1 END)::float8 * floor(a + 0.5::float8) / 100::float8;
  END IF;

  -- Near a boundary: defer to the exact path rather than keeping a second copy of it.
  RETURN php_round2(v)::float8;
END
$$;

COMMENT ON FUNCTION php_round2f(double precision) IS
  'php_round2(v)::float8, without the numeric round trip. Exactly equal to it for every input — see migration 20260816090000. Use for intermediate roundings; use php_round2 for final sums.';
