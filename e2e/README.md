# End-to-end tests

Browser tests driven through a real Chromium against a real stack, on a **disposable database**.

They delete records, submit bad data deliberately and sign in as six different people. None of
that may happen near the live database, which holds real client identification and real commission
figures — so nothing here has a default connection string. `TEST_DATABASE_URL` must be set
explicitly, and is rejected unless the database name identifies it as a test one.

---

## One-time setup

```bash
# 1. Create the database and bring it to the current schema
psql "$PROD_URL" -c "CREATE DATABASE myapp_test;"
cd ../server && DATABASE_URL="postgresql://…/myapp_test?schema=public" npx prisma migrate deploy

# 2. Seed a brokerage and the role accounts
TEST_DATABASE_URL="postgresql://…/myapp_test?schema=public" node scripts/seed-test-env.cjs

# 3. Install the runner and its browser
cd ../e2e && npm install && npx playwright install chromium
```

Roles and permissions arrive with the migrations, so no extra step is needed for authorization to
work — a fresh database comes up fully authorized.

## Running

```bash
cd e2e
export TEST_DATABASE_URL="postgresql://…/myapp_test?schema=public"

npm test              # headless
npm run test:headed   # watch it happen
npm run report        # open the HTML report from the last run
```

The config starts both halves itself — the API on **8100** and the SPA on **5174** — so the
development stack on 8000/5173 keeps running untouched and nothing needs stopping first.

Failures leave a screenshot, a video and a trace under `test-results/`:

```bash
npx playwright show-trace test-results/<failing-test>/trace.zip
```

## Test accounts

All share the password **`TestPass123!`**. They exist only in the test database.

| Email | Role (stored) | Role (UI label) |
|---|---|---|
| `superadmin@test.local` | `admin` | Super Admin |
| `admin@test.local` | `manager` | Admin |
| `agent@test.local` | `agent` | Agent — owns the seeded mailbox and most leads |
| `agent2@test.local` | `agent` | Agent — the "other" agent, for isolation tests |
| `accounting@test.local` | `accounting` | Accounting / Finance |
| `docs@test.local` | `documentation` | Documentation / Office Staff |
| `crm@test.local` | `crm` | CRM |

The stored key and the UI label differ and have caught people out before: **`admin` is Super
Admin** and **`manager` is Admin**.

## Safety

Three independent guards, because one is not enough when the cost is production data:

1. `playwright.config.ts` refuses to start without `TEST_DATABASE_URL`, and refuses any name that
   does not contain `test`/`staging`/`qa`/`scratch` — or that contains `prod`.
2. `seed-test-env.cjs` applies the same check before writing anything.
3. The API is started with `IMAP_POLL_DISABLED=1`, `RUN_SCHEDULERS=false` and
   `MAIL_REDIRECT_TO`, so a run cannot reach a real mailbox, mail server or push service.

## Writing tests

Two things that have already caught us out here:

- **`locator.count()` does not wait.** It returns whatever is rendered at that instant, so it will
  read `0` on a list that is still loading. Use `expect(locator).toHaveCount(n)`, which retries.
- **Tests share one database.** Anything that stores a change must undo it, or the second run of
  the suite fails on assertions that passed the first. `notification-preferences.spec.ts` resets
  through the UI in `beforeEach` rather than trusting the previous test to clean up.
