-- desk_report_num: the Reports module's `num()`, which is NOT the commission engine's.
--
-- WHY A SECOND COERCION EXISTS. There are three ways this application turns a free-form JSON value
-- into a number, and they disagree on purpose:
--
--   common/serialize.ts   phpFloat  — PHP's (float) cast: longest numeric PREFIX. "90%" is 90.
--   dashboard             num       — Number(v). "1200.50" is 1200.5, "n/a" is 0.
--   reports/report-financials.ts num — Number(v) AFTER stripping $ , and whitespace.
--
-- The last one is the odd one, and it is the one the payment figures use:
--
--   if (typeof v === 'string') { const n = Number(v.replace(/[$,\s]/g, '')); … }
--
-- because agent payment amounts are typed by people and arrive as "$1,234.56" as often as 1234.56.
-- Reading them with `desk_json_num` — which is a strict Number() — turns every formatted amount into
-- zero. MEASURED on the 80,000-deal corpus with realistic payment history: the SQL footer came out
-- $2,558,016.24 short of the enrichment path, entirely from dollar-and-comma amounts. The scale
-- parity check is what found it.
--
-- WHAT IT DOES, EXACTLY:
--   · a JSON number  -> its value
--   · a JSON string  -> strip every $, comma and space, ANYWHERE in the string, then Number()
--   · anything else  -> 0, which is what Number(true), Number([]) and Number({}) come to after the
--                       TypeScript's own guards
--   · '' -> 0, because Number('') is 0 and not NaN
--   · non-numeric -> 0, because the TypeScript rejects a NaN
--   · 'Infinity' -> 0, because the TypeScript rejects a non-finite value
--
-- ONE KNOWN DIVERGENCE, stated rather than hidden: JavaScript's Number() also accepts 0x/0o/0b
-- literals, and this returns 0 for them. A commission payment recorded as "0x1F" is not a case worth
-- carrying a hexadecimal parser for; if one ever appears, this reports zero where the enrichment path
-- reports 31, and the parity spec will say so.
--
-- IT RETURNS `numeric`, VIA `float8`. The TypeScript builds `new Decimal(num(v))` from a JavaScript
-- double, and decimal.js takes the double's shortest round-trip representation. Parsing to float8
-- first and then casting reproduces exactly that; casting the text straight to numeric would keep
-- digits the double never had.

CREATE OR REPLACE FUNCTION desk_report_num(v jsonb)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  s text;
  n double precision;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN 0; END IF;
  IF jsonb_typeof(v) = 'number' THEN
    n := v::text::float8;
    IF n <> n OR n = 'Infinity'::float8 OR n = '-Infinity'::float8 THEN RETURN 0; END IF;
    RETURN n::numeric;
  END IF;
  -- Number(true), Number([]) and Number({}) are all rejected by the TypeScript before Number() is
  -- reached, or reach it as '[object Object]'. Every one of them comes to 0.
  IF jsonb_typeof(v) <> 'string' THEN RETURN 0; END IF;

  s := regexp_replace(v #>> '{}', '[$,[:space:]]', '', 'g');
  IF s = '' THEN RETURN 0; END IF;
  IF s !~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$' THEN RETURN 0; END IF;

  n := s::float8;
  IF n <> n OR n = 'Infinity'::float8 OR n = '-Infinity'::float8 THEN RETURN 0; END IF;
  RETURN n::numeric;
END
$$;

COMMENT ON FUNCTION desk_report_num(jsonb) IS
  'reports/report-financials.ts:num — Number(v) after stripping $, commas and whitespace from a string. Distinct from desk_json_num (no stripping) and desk_php_float (numeric prefix). Guarded by reports/report-payments-parity.spec.ts.';

-- desk_agent_paid reads amounts through the REPORTS coercion, because that is the function
-- `agentPaymentsPaid` calls. See migration 20260816100000 for the rest of its reasoning.
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
  IF rec IS NULL OR jsonb_typeof(rec) <> 'object' THEN RETURN 0; END IF;
  IF jsonb_typeof(rec -> 'payments') <> 'array' THEN RETURN 0; END IF;

  FOR p IN SELECT * FROM jsonb_array_elements(rec -> 'payments') LOOP
    IF jsonb_typeof(p) = 'object' AND (p ->> 'paid_status') = 'Paid' THEN
      total := total + desk_report_num(p -> 'amount');
    END IF;
  END LOOP;
  RETURN total;
END
$$;
