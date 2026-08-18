-- Transaction Desk: the remaining pieces of the commission engine the Dashboard aggregate needs.
--
-- These sit beside `php_round2` and `desk_gross_commission` (migration 20260815090000). Same rule
-- applies: each is a transliteration of a named function in the TypeScript, operation for operation,
-- and `core/desk-sql-parity.spec.ts` runs both over every transaction in the database and requires
-- exact equality. Nothing here is "an equivalent formula".
--
-- READ THIS BEFORE CHANGING ANY OF THEM. Every one has a partner in `src/`:
--
--   desk_safe_jsonb   -> common/serialize.ts        parseJsonObject
--   desk_json_num     -> dashboard.service.ts       num / CommissionService.num
--   desk_php_float    -> common/serialize.ts        phpFloat
--   desk_gross_base   -> CommissionService          grossBase
--   desk_member_paid  -> dashboard.service.ts       memberPaid
--
-- ---------------------------------------------------------------------------
-- `parseJsonObject` — a JSON blob column as an object, or `{}`.
--
-- The columns are `text`, not `jsonb`, and they hold whatever was written to them over the years.
-- The TypeScript answers `{}` for null, for the empty string and for anything that does not parse;
-- a bare `::jsonb` cast would instead abort the whole aggregate on one malformed row somewhere in
-- eighty thousand. plpgsql because catching the cast is the only way to reproduce "invalid means
-- empty", and IMMUTABLE because it genuinely is: same text in, same object out.
CREATE OR REPLACE FUNCTION desk_safe_jsonb(t text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF t IS NULL OR t = '' THEN RETURN '{}'::jsonb; END IF;
  BEGIN
    -- A valid JSON scalar or array is not an object; `parseJsonObject` requires an object and
    -- answers `{}` otherwise, so the type is checked rather than assumed.
    IF jsonb_typeof(t::jsonb) = 'object' THEN RETURN t::jsonb; END IF;
    RETURN '{}'::jsonb;
  EXCEPTION WHEN others THEN
    RETURN '{}'::jsonb;
  END;
END;
$$;

-- ---------------------------------------------------------------------------
-- `Number(v)` on a value out of one of those blobs — non-finite and non-numeric become 0.
--
-- The adjustment rows are user-entered and are not consistently typed: the same field is a JSON
-- number on one deal and a quoted string on another. `Number("1200.50")` is 1200.5 and
-- `Number("n/a")` is NaN, which the TypeScript turns into 0. Both cases arrive here.
CREATE OR REPLACE FUNCTION desk_json_num(v jsonb)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  s text;
  n double precision;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN 0; END IF;
  IF jsonb_typeof(v) = 'number' THEN RETURN v::text::float8; END IF;
  IF jsonb_typeof(v) <> 'string' THEN RETURN 0; END IF;   -- Number([]) / Number({}) -> 0 / NaN -> 0
  s := btrim(v #>> '{}');
  IF s = '' THEN RETURN 0; END IF;                        -- Number('') is 0, not NaN
  BEGIN
    n := s::float8;
  EXCEPTION WHEN others THEN
    RETURN 0;
  END;
  IF n <> n OR n = 'Infinity'::float8 OR n = '-Infinity'::float8 THEN RETURN 0; END IF;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------
-- `phpFloat` — PHP's `(float)` cast, which is `parseFloat`: read the longest numeric PREFIX and
-- ignore the rest, with no numeric prefix meaning 0.
--
-- This is not the same as `desk_json_num` and the difference is load-bearing: a commission
-- percentage stored as "90%" is 90 through this function and 0 through a strict cast. It is read
-- from `users.profile`, which is free-form JSON a person filled in.
CREATE OR REPLACE FUNCTION desk_php_float(t text)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    (substring(btrim(COALESCE(t, '')) from '^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?'))::float8,
    0
  );
$$;

-- ---------------------------------------------------------------------------
-- `CommissionService.grossBase` — the base for the STANDARD split, which is NOT
-- `desk_gross_commission`.
--
-- Two differences, both deliberate in the original and both easy to lose:
--
--   · It has no Preconstruction or listing branch. It is only ever reached from the standard
--     breakdown, so a deal's type never redirects it.
--   · It ROUNDS EACH BRANCH. `grossCommission` returns the raw product and lets the caller round
--     once; `grossBase` rounds inside. On a percentage of an odd price the two differ in the last
--     cent, and that cent then propagates through the whole agent split.
CREATE OR REPLACE FUNCTION desk_gross_base(
  p_price      double precision,
  p_comm_type  text,
  p_comm_value double precision,
  p_comm_pct   double precision,
  p_comm_amt   double precision
)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_comm_amt IS NOT NULL AND p_comm_amt > 0 THEN php_round2(p_comm_amt)::float8
    WHEN p_comm_pct IS NOT NULL AND p_comm_pct > 0 THEN php_round2((p_price * p_comm_pct) / 100)::float8
    WHEN p_comm_type = '%'     AND p_comm_value > 0 THEN php_round2((p_price * p_comm_value) / 100)::float8
    WHEN p_comm_type = 'Fixed' AND p_comm_value > 0 THEN php_round2(p_comm_value)::float8
    ELSE 0
  END;
$$;

-- ---------------------------------------------------------------------------
-- `DashboardService.memberPaid` — has this person been paid on this deal?
--
-- The shape is `admin_activities.agents[<name>].payments[]`, and a member counts as paid once ANY
-- payment row on their entry says so. Everything about the path is defensive because all of it is
-- optional: no `agents` key, no entry for that name, no `payments` array, or a `payments` value
-- that is not an array at all — each of which the TypeScript treats as "not paid" rather than as an
-- error.
CREATE OR REPLACE FUNCTION desk_member_paid(admin jsonb, member_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE((
    SELECT bool_or(p->>'paid_status' = 'Paid')
    FROM jsonb_array_elements(
      CASE
        WHEN member_name IS NOT NULL
         AND jsonb_typeof(admin->'agents') = 'object'
         AND jsonb_typeof(admin->'agents'->member_name) = 'object'
         AND jsonb_typeof(admin->'agents'->member_name->'payments') = 'array'
        THEN admin->'agents'->member_name->'payments'
        ELSE '[]'::jsonb
      END
    ) p
  ), false);
$$;

-- ---------------------------------------------------------------------------
-- The Dashboard aggregate walks team members and precon terms for a whole scope at once. Both are
-- indexed by transaction already; this is the covering pair that lets the member walk be an
-- index-only scan rather than a heap fetch per row.
CREATE INDEX IF NOT EXISTS team_members_txn_position_idx
  ON team_members (transaction_id, position, id);

CREATE INDEX IF NOT EXISTS transaction_statuses_txn_status_idx
  ON transaction_statuses (transaction_id, status);
