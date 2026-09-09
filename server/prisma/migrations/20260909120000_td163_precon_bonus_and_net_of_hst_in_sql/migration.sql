-- TD-163 - THE SQL COPY OF THE COMMISSION RULE HAD DRIFTED FROM THE TYPESCRIPT.
--
--   1. desk_gross_commission never learned precon_comm_bonus. TD-130 added that field to
--      CommissionService.grossCommission() on 2026-09-07 and to the schema in migration
--      20260907180000, and the function was not touched. 160 of the brokerage 430 preconstruction
--      deals carry a bonus.
--
--   2. Nothing in the SQL knew about precon_net_of_hst. A net-of-HST preconstruction fee is
--      TAX-INCLUSIVE: a 3% fee on a 1,000,000 deal is 30,000 in total, 26,548.67 of commission with
--      3,451.33 of tax already inside it. The SQL returned the whole 30,000 as the commission
--      amount. THAT IS TD-066, WHICH WAS FIXED IN THE TYPESCRIPT AND CAME BACK HERE.
--
-- Together these accounted for 6,705.76 - exactly the gross difference the parity spec reported.
--
-- THE DIVISOR IS THE LITERAL 1.13 AND THAT IS DELIBERATE. Everywhere else a gross-up is written
-- (1::float8 + 0.13::float8) because that is the double the TypeScript computes from 1 + HST_RATE.
-- summarize() does NOT do that - it divides by the literal 1.13 - and those are different doubles.

CREATE OR REPLACE FUNCTION public.desk_gross_amount(
  p_type text, p_price double precision, p_comm_type text, p_comm_value double precision,
  p_comm_pct double precision, p_comm_amt double precision,
  p_listing_comm_pct double precision, p_coop_comm_pct double precision,
  p_listing_comm_flat double precision, p_coop_comm_flat double precision,
  p_precon_comm_pct double precision, p_precon_comm_amt_manual double precision,
  p_precon_comm_bonus double precision, p_precon_net_of_hst boolean
) RETURNS double precision
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $function$
  WITH fee AS (
    SELECT CASE
      WHEN p_type = 'Preconstruction' THEN
        CASE
          WHEN p_precon_comm_amt_manual IS NOT NULL AND p_precon_comm_amt_manual > 0
            THEN p_precon_comm_amt_manual
          ELSE (p_price * COALESCE(p_precon_comm_pct, 0)) / 100
        END + COALESCE(p_precon_comm_bonus, 0)
      WHEN p_type IN (
        'Residential Sale Listing', 'Residential Lease Listing',
        'Commercial Property Sale Listing', 'Commercial Property Lease Listing', 'Business Sale'
      ) THEN
        ((p_price * COALESCE(p_listing_comm_pct, 0)) / 100 + COALESCE(p_listing_comm_flat, 0))
        + ((p_price * COALESCE(p_coop_comm_pct, 0)) / 100 + COALESCE(p_coop_comm_flat, 0))
      WHEN p_comm_amt IS NOT NULL AND p_comm_amt > 0 THEN p_comm_amt
      WHEN p_comm_pct IS NOT NULL AND p_comm_pct > 0 THEN (p_price * p_comm_pct) / 100
      WHEN p_comm_type = '%' AND p_comm_value > 0 THEN (p_price * p_comm_value) / 100
      WHEN p_comm_type = 'Fixed' AND p_comm_value > 0 THEN p_comm_value
      ELSE 0
    END AS raw
  )
  SELECT CASE
    WHEN p_type = 'Preconstruction' AND COALESCE(p_precon_net_of_hst, false)
      THEN php_round2(php_round2(raw)::float8 / 1.13::float8)::float8
    ELSE php_round2(raw)::float8
  END
  FROM fee;
$function$;

-- The old twelve-argument desk_gross_commission is NOT dropped here. The application database
-- user does not own it - it was created by postgres - and DROP inside this migration fails with
-- 42501, taking the whole transaction with it. Nothing calls it after this migration; it is
-- dropped separately by the owner. A dead second copy of a financial rule is exactly what
-- TD-163 is about, so this is a loose end, not a decision.
