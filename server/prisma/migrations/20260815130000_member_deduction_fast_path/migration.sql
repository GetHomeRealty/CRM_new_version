-- desk_member_deduction: leave immediately when there is nothing to deduct.
--
-- The function is called once per agent line — and on a preconstruction deal, once per line PER
-- TERM. Measured at 80,000 deals it added six seconds to the preconstruction branch alone, and
-- almost all of that was spent proving there was nothing to find: it expanded two JSON arrays and
-- scanned them for a matching name on every deal, including the great majority whose adjustment blob
-- has both flags set to No or is simply {}.
--
-- The guard is the same test the TypeScript makes before it looks at anything. `memberDeduction`
-- returns 0 for an empty blob, and each of its two loops is gated on its own Yes/No flag, so a deal
-- with neither flag set sums nothing and returns round2(0). Answering 0 without opening the arrays is
-- the same answer, not an approximation of it.
--
-- Guarded, as before, by core/desk-sql-parity.spec.ts.
CREATE OR REPLACE FUNCTION desk_member_deduction(adj jsonb, member_name text, p_term int)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN member_name IS NULL THEN 0::float8
    WHEN COALESCE(adj->>'agent_adjust', 'No') <> 'Yes'
     AND COALESCE(adj->>'advance_payment', 'No') <> 'Yes' THEN 0::float8
    ELSE php_round2(COALESCE((
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
          OR COALESCE(NULLIF(substring(COALESCE(r->>'term', '0') from '^[+-]?[0-9]+'), '')::int, 0) = p_term
        )
    ), 0))::float8
  END;
$$;
