-- `CommissionService.memberDeduction` — what is taken off one member's line on one deal.
--
-- The last piece of the commission engine the database did not have. The Dashboard did not need it
-- (its T4A line is deliberately computed BEFORE deductions), but the Reports totals do: an agent's
-- commission column on a report is the line AFTER the adjustment and the advance have been taken
-- off, and a total that ignored them would be the brokerage's gross rather than what anybody is
-- owed.
--
-- Two independent sources, each gated by its own Yes/No flag:
--   · `adjustment_rows` when `agent_adjust` is Yes — manual adjustments, including loan repayments.
--   · `advance_rows` when `advance_payment` is Yes — commission already advanced to the agent.
--
-- `p_term` is the preconstruction term this line belongs to, or NULL for the single-line variants.
-- When it is set, a row only counts if its own `term` matches — that is `toInt(r['term'] ?? 0)`, so
-- a row with no term at all reads as term 0 and belongs to no real term. Passing NULL disables the
-- filter entirely rather than matching term 0, which is what the TypeScript's `term !== null` guard
-- does.
--
-- Amounts go through `desk_json_num` because these are user-entered and are a number on one deal and
-- a quoted string on the next. Names are compared exactly, as `(r['agent'] ?? null) === name` does.
--
-- Guarded by core/desk-sql-parity.spec.ts alongside the rest of the engine.
CREATE OR REPLACE FUNCTION desk_member_deduction(adj jsonb, member_name text, p_term int)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT php_round2(COALESCE((
    SELECT SUM(desk_json_num(r->'amount'))
    FROM (
      SELECT r FROM jsonb_array_elements(
        CASE WHEN COALESCE(adj->>'agent_adjust', 'No') = 'Yes'
              AND jsonb_typeof(adj->'adjustment_rows') = 'array'
             THEN adj->'adjustment_rows' ELSE '[]'::jsonb END) r
      UNION ALL
      SELECT r FROM jsonb_array_elements(
        CASE WHEN COALESCE(adj->>'advance_payment', 'No') = 'Yes'
              AND jsonb_typeof(adj->'advance_rows') = 'array'
             THEN adj->'advance_rows' ELSE '[]'::jsonb END) r
    ) rows
    WHERE r->>'agent' IS NOT DISTINCT FROM member_name
      AND (
        p_term IS NULL
        -- `toInt` of an absent or unparseable term is 0, which matches no real term (they start at 1).
        OR COALESCE(NULLIF(substring(COALESCE(r->>'term', '0') from '^[+-]?[0-9]+'), '')::int, 0) = p_term
      )
  ), 0))::float8;
$$;

COMMENT ON FUNCTION desk_member_deduction(jsonb, text, int) IS
  'CommissionService.memberDeduction. Guarded by core/desk-sql-parity.spec.ts.';
