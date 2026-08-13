# Phase 2 — Authentication & Session Security

**Date:** 2026-08-06
**Scope:** the auth module only (`server/src/auth/`, `e2e/tests/auth-session-security.spec.ts`)
**Status:** complete. Phase 3 (MFA) not started, per the instruction not to begin it until this was done.

---

## Summary

Phase 2 was specified as a test-writing exercise. Writing the tests found two exploitable
vulnerabilities in the sign-in path. Both were reproduced against the running application before
anything was changed, both are fixed, and both fixes were sensitivity-checked by reverting them and
confirming the tests go red.

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Session fixation — the pre-login session identifier survived authentication | High | Fixed |
| 2 | LIKE wildcards were live in the login string (`%`, `_`) | High | Fixed |

Nothing else in the module needed a behaviour change.

---

## Finding 1 — Session fixation

### What was wrong

`AuthController.login()` set `req.session.userId` directly onto the session the request arrived
with. The line carried the comment `// Auth::login + session regenerate`, but no `session.regenerate()`
existed anywhere in `server/src/` — the comment described an intent that was never implemented.

This matters because `GET /sanctum/csrf-cookie` writes `req.session.csrfToken`, which creates a
session and issues a `laravel_session` cookie to a visitor who has not typed anything yet. The
identifier a visitor arrives with therefore became the identifier of an authenticated user.

### Why it is exploitable

An attacker who can plant a session cookie in a victim's browser — from a sibling subdomain, an XSS
anywhere on the origin, or a shared machine — holds a cookie that becomes authenticated the moment
the victim signs in. No password is involved at any point.

### Proof, before the fix

A Playwright request context primed a CSRF cookie, captured the `laravel_session` value, and the
victim then signed in from that same jar. A second, independent context carrying only the captured
pre-login cookie was sent to `GET /api/user`:

```
expected 401, received 200
```

The pre-login identifier was fully authenticated.

### The fix

`server/src/auth/auth.controller.ts` — a new private `startAuthenticatedSession()`, used by both
`login()` and `register()`:

1. `req.session.regenerate()` — destroys the old record and starts a new one, so a planted
   identifier is left pointing at nothing.
2. `req.session.userId` is set on the new session.
3. `remember me`'s 60-day `cookie.maxAge` is applied **after** regeneration. A regenerated session
   starts from the configured default lifetime, so setting it earlier would be silently discarded.
4. A fresh CSRF token is minted and returned in the same response (see below).
5. `req.session.save()` is awaited explicitly, so the new record exists in `user_sessions` before
   the caller is told it is signed in.

### Why the CSRF token is re-issued rather than carried across

Regeneration empties the session, and `CsrfGuard` reads its counterpart from there. Carrying the old
token over would have worked, but it would keep a token minted for an *anonymous* session alive
across a privilege change. Re-minting rotates both halves of the pair at the same boundary.

This is transparent to the SPA: `client/src/lib/axios.ts` sets `withXSRFToken: true`, which reads the
`XSRF-TOKEN` cookie per request, and no code anywhere in `client/src/` caches the token in a
variable. The browser stores the new cookie from the login response itself, so the next write carries
the new value with no extra round trip. Verified by test, not by inference — see
`the CSRF token is REPLACED at sign-in, and the new one works immediately`.

---

## Finding 2 — LIKE wildcards in the login string

### What was wrong

`AuthService.findAuthenticatable()` matched the login string with Prisma's `mode: 'insensitive'`.
That compiles to **ILIKE**, and ILIKE's right-hand side is a *pattern* — so the string typed into
the login box was being used as one. `%` and `_` were live wildcards.

### Proof, before the fix

With a probe account at `zz-auth-<id>@probe.test` holding a known password:

```
login('ZZ%@probe.test', '<that account's password>')  →  signed in successfully
```

A sign-in by a caller who never knew the address.

### Why it is exploitable

It turns a targeted guess into an untargeted spray. An administrator hands out a standard temporary
password — public registration is closed, so an administrator creates every account in this system —
and `%` or `staff%@brokerage.ca` finds somebody it fits without the attacker knowing a single
address. It also breaks the contract the rest of the module assumes: that the account which signs in
is the account that was named.

### The fix

`server/src/auth/auth.service.ts` — a parameterised raw query using exact equality on `lower(...)`:

```sql
SELECT id, lower(username) = lower($1) AS by_username
FROM users
WHERE lower(username) = lower($1) OR lower(email) = lower($1)
ORDER BY by_username DESC NULLS LAST, id ASC
LIMIT 2
```

Equality has no pattern semantics, so there is nothing to escape and nothing to get wrong. Username
precedence over email is preserved (a username may itself be email-formatted). `LIMIT 2` is the most
there can ever be, because both columns are uniquely indexed on `lower(...)`.

### Secondary benefit: the index

`users_email_lower_key` and `users_username_lower_key` are functional indexes on `lower(...)`. ILIKE
could not use either, so every sign-in was a sequential scan. This form matches them exactly. The
original comment in the file had already anticipated this half of the change:

> *"If `users` ever grows past that, replace this with a raw `lower(email) = lower($1)` so the index
> is used again."*

### What was preserved

Case-insensitive sign-in is a deliberate behaviour, not an accident — the account already exists once
case-insensitively, and an exact match would mean an address stored with a capital could not be typed
in lower case. `e2e/tests/login-case.spec.ts` (`agent@test.local`, `AGENT@TEST.LOCAL`,
`Agent@Test.Local`) passes unchanged.

---

## Tests added

### `server/src/auth/authentication.spec.ts` — new, 39 tests

Before this file, `server/src/auth/` contained tests for password *hashing* and nothing else. There
was not one test for signing in, for the credentials being wrong, for a deactivated account, or for
the brute-force brake. The e2e suite signs in constantly but only ever on the happy path — every one
of those tests would still have passed if `login` accepted any password at all for an existing user,
because none of them ever sends a wrong one.

- **Correct credentials** — by email, by username, upper/mixed case on both, password case
  sensitivity, punctuation/spaces/non-Latin passwords.
- **Bad credentials** — wrong password, unknown account, *identical response for both* (no account
  enumeration, compared field by field rather than message alone), empty and whitespace passwords,
  empty login, an empty stored hash.
- **Injection** — `' OR '1'='1`, `admin'--`, `" OR ""="`, `; DROP TABLE users; --`.
- **Wildcards** — six tests, each aiming a wildcard at a user whose password it also supplies.
- **Account state** — Inactive refused with the right password; an Inactive account not counted
  toward the lockout; `loadUser` resolving Inactive to null so an existing session dies; only the
  exact string `Inactive` shutting an account out; the `Active` default.
- **Lockout** — locks after the configured count, locks out the *correct* password once tripped, a
  success before the limit clears the count, one account's lockout does not affect another, case
  normalisation.
- **Lockout window** — expiry, the boundary one millisecond before expiry, that the window does
  **not** slide (a sliding window would let a patient attacker hold a colleague's account locked
  indefinitely), and the `retry_after` value.

### `e2e/tests/auth-session-security.spec.ts` — 25 tests

Sessions, cookies, CSRF and fixation are properties of an HTTP exchange and cannot be observed from
a service call, so these run against the real stack through Playwright's request context — a cookie
jar with no JavaScript in it, which is exactly the client an attacker has.

- **Session fixation** — the identifier changes at sign-in; a captured pre-login identifier cannot
  be used afterwards.
- **Session lifecycle** — reaching a protected endpoint, logout destroying the server-side record
  (replaying the exact cookie fails), a second logout not 500ing, invalid and absent identifiers,
  two concurrent sessions working independently.
- **Cookie attributes** — `HttpOnly` on the session cookie, the XSRF cookie deliberately readable
  *and* carrying no authority alone, `Path=/` and an explicit `SameSite`, and no readable user
  information in the identifier.
- **Remember me** — extends well beyond the default, an ordinary sign-in does not, and a remembered
  session still regenerates its identifier (the fixation fix has no opt-out).
- **CSRF** — missing token, wrong token, *another session's valid token*, GETs exempt, the token
  replaced at sign-in and usable immediately, and the pre-login token refused afterwards.
- **Account state** — changing a password ends other sessions.
- **Authorization** — unauthenticated refused, an agent refused administrator-only screens, a Super
  Admin reaching them.

---

## Sensitivity checks

A test that cannot fail is not coverage. Each fix was reverted and the suite re-run.

| Reverted to | Result |
|---|---|
| `lower(x) ILIKE lower($1)` | 5 wildcard tests fail; restoring makes them pass |
| `cookie.maxAge` set *before* `regenerate()` | `remember me › extends the session cookie well beyond the default` fails |
| (fixation) the pre-fix build | the 2 fixation tests failed on the old build and pass on the new one, same spec file, same session |

A note on the wildcard tests: each one aims a wildcard at a user whose password it also supplies, so
against the vulnerable code the sign-in **succeeds** and the test fails. A bare `%` would have been
the weaker test — it matches whichever row the scan reaches first, usually an unrelated user whose
password does not match, so it goes green against vulnerable code and proves nothing. It is kept, but
only as a companion to the targeted ones.

---

## Corrections to earlier work in this suite

- `changing a password ends the OTHER sessions` asserted only that the change returned 200. It never
  opened a second session, so it would have passed with session invalidation removed entirely — the
  same defect found earlier in `users-validation.spec.ts`. It now opens two sessions, proves the
  other one is 401 afterwards, states that the initiating session is ended too, and confirms the new
  password works.
- A test asserting that a `null` status is treated as active was written on a wrong premise: the
  column is `NOT NULL DEFAULT 'Active'`, so that state is unreachable from the database. Replaced
  with what is actually true — that only the exact string `Inactive` shuts an account out, and that
  the default is applied.
- `primeCsrf()` initially called `/api/sanctum/csrf-cookie`. The route is excluded from the global
  prefix (`app.setGlobalPrefix('api', { exclude: ['sanctum/csrf-cookie'] })`), so the real path is
  `/sanctum/csrf-cookie`. **`docs/audit/api-inventory.txt` lists this route with the `/api` prefix
  and is wrong on that one row.**

---

## Verification

| Suite | Result |
|---|---|
| `server` jest, full | **1094 / 1094 passed**, 81 suites |
| `e2e` Playwright, full | **329 / 329 passed** |
| `e2e/tests/auth-session-security.spec.ts` | **25 / 25 passed** |
| `server/src/auth/` | **69 / 69 passed** |
| `tsc --noEmit` | clean |
| `nest build` | clean |

The full e2e run above predates the remember-me and CSRF-rotation tests; those were run separately
and are included in the 25.

---

## Reported, not changed — outside this module

39 other call sites use `mode: 'insensitive'`. Most are `contains` search boxes, where a wildcard
over-matches but grants nothing. The `equals` ones are worth review under their own module's scope:

| Location | Use | Risk if a wildcard reaches it |
|---|---|---|
| `server/src/leads/leads.service.ts:385`, `:865` | lead dedupe by email | wrong lead matched or merged |
| `server/src/meta/meta-sync.service.ts:156`, `:183` | lead dedupe by email | as above, on imported leads |
| `server/src/crm-settings/crm-settings.service.ts:444`, `:451` | username/email uniqueness | false "already taken" |
| `server/src/inbox/imap-sync.service.ts:422` | sender match | wrong contact attributed |
| `server/src/google/gmail-connect.service.ts:32` | connection lookup by address | wrong connection matched |

`server/src/auth/auth.service.ts:245` (registration's duplicate-email pre-check) also uses it, but is
guarded by `count() > 0` and therefore only ever runs against an empty table. Not exploitable; left
unchanged deliberately rather than overlooked.

`server/src/leads/lead-import.engine.ts` already documents this exact ILIKE-versus-index problem and
uses raw SQL to avoid it, so the pattern for fixing the rest is established in the codebase.

---

## Not done, by instruction

Phase 3 (MFA) has not been started. Suggested slicing when it is: TOTP + recovery codes + the login
challenge + enrollment UI first; then email/SMS OTP behind a provider abstraction; then trusted
devices and enforcement policies. Each slice is independently shippable, which the whole of Phase 3
as one unit is not.
