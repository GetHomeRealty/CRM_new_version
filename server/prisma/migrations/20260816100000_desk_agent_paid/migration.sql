-- desk_agent_paid: what one named agent has actually been paid on a deal.
--
-- WHY. Two Payment reports — Sales Statement and Transaction Payment Status — total the agent
-- commission that has been PAID, and that figure lives inside the `admin_activities` JSON blob
-- rather than in a column. Answering it meant reading and enriching every deal in the brokerage:
-- 8.7 s at 80,000 deals to print twenty-five lines and a footer.
--
-- WHAT IT IS. A transliteration of `agentPaymentsPaid` from reports/report-financials.ts, for ONE
-- name. The caller sums it over the deal's agent lines, which is what the TypeScript loop does.
--
--   for (const name of names) {
--     for (const p of admin.agents[name].payments) {
--       if (String(p.paid_status) === 'Paid') { total += num(p.amount); … }
--     }
--   }
--
-- THREE DETAILS THAT ARE EASY TO GET WRONG, AND ARE NOT:
--
--   · THE CALLER SUMS OVER A MULTISET, NOT A SET. `names` comes from `agentLines(bd)`, which emits
--     one entry per agent line — and a preconstruction deal emits one line per agent PER TERM. An
--     agent on a four-term deal therefore has their payments counted four times. That is what the
--     application does today and what these reports show today, so the SQL reproduces it by summing
--     over the same lines rather than over distinct names. Deduplicating here would "fix" a figure
--     the brokerage reconciles against.
--   · 'Paid' IS COMPARED EXACTLY, `String(p.paid_status) === 'Paid'` — not case-insensitively, not
--     trimmed. 'paid' is not Paid.
--   · AMOUNTS GO THROUGH THE SAME COERCION as `num()`: a number, or a string that may carry a
--     dollar sign, commas or spaces; anything else is zero. desk_json_num already implements exactly
--     that and is reused rather than re-spelled.
--   · IT RETURNS `numeric`, AND ADDS AS `numeric`. The TypeScript accumulates with decimal.js —
--     `total.plus(num(p.amount))` — which is exact decimal addition of each double's shortest
--     representation, and float8 addition is not. Casting each amount to numeric before adding
--     reproduces it; adding in float8 and casting at the end does not.
--
-- Guarded by reports/report-payments-parity.spec.ts, which compares the fast path against the
-- original enrichment over every deal in the database.

CREATE OR REPLACE FUNCTION desk_agent_paid(admin jsonb, member_name text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  rec jsonb;
  total numeric := 0;
  p jsonb;
BEGIN
  IF admin IS NULL OR member_name IS NULL THEN RETURN 0; END IF;
  rec := admin -> 'agents' -> member_name;
  -- obj() in the TypeScript: anything that is not a plain object contributes nothing.
  IF rec IS NULL OR jsonb_typeof(rec) <> 'object' THEN RETURN 0; END IF;
  IF jsonb_typeof(rec -> 'payments') <> 'array' THEN RETURN 0; END IF;

  FOR p IN SELECT * FROM jsonb_array_elements(rec -> 'payments') LOOP
    IF jsonb_typeof(p) = 'object' AND (p ->> 'paid_status') = 'Paid' THEN
      total := total + desk_json_num(p -> 'amount')::numeric;
    END IF;
  END LOOP;
  RETURN total;
END
$$;

COMMENT ON FUNCTION desk_agent_paid(jsonb, text) IS
  'Sum, as numeric, of admin_activities.agents[name].payments[] amounts whose paid_status is exactly Paid. Transliteration of reports/report-financials.ts:agentPaymentsPaid for one name. Guarded by reports/report-payments-parity.spec.ts.';

-- Whether that agent has ANY paid row — `paidNames` in the TypeScript, which decides the payment
-- status. Separate from the total because a zero-amount Paid row still counts as paid.
CREATE OR REPLACE FUNCTION desk_agent_any_paid(admin jsonb, member_name text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  rec jsonb;
  p jsonb;
BEGIN
  IF admin IS NULL OR member_name IS NULL THEN RETURN false; END IF;
  rec := admin -> 'agents' -> member_name;
  IF rec IS NULL OR jsonb_typeof(rec) <> 'object' THEN RETURN false; END IF;
  IF jsonb_typeof(rec -> 'payments') <> 'array' THEN RETURN false; END IF;
  FOR p IN SELECT * FROM jsonb_array_elements(rec -> 'payments') LOOP
    IF jsonb_typeof(p) = 'object' AND (p ->> 'paid_status') = 'Paid' THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END
$$;

COMMENT ON FUNCTION desk_agent_any_paid(jsonb, text) IS
  'True when the named agent has at least one Paid payment row on the deal. Feeds the agent payment status. Guarded by reports/report-payments-parity.spec.ts.';
