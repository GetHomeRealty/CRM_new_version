# Google OAuth — `Error 403: org_internal`

**Status:** the fix is a Google Cloud console change. There is no code defect, and no code change was
made to the connect path.

---

## The finding, in one line

The OAuth consent screen's **User Type is Internal**. Google enforces that on its own sign-in page,
before the browser is ever redirected back to this application, so no code here runs and none of it
can intervene.

That is why the screenshot shows Google's page and not ours, and why the message names the *Google
Cloud project* ("Get Home Realty") rather than the CRM.

---

## Current configuration, as read from the running system

| Item | Value |
| --- | --- |
| Calendar client ID | `485561878286-604293mtcdo5o74qcbdomm1uo6k1c8lu.apps.googleusercontent.com` |
| Calendar client secret | set (not reproduced here) |
| Mail client ID (`GOOGLE_MAIL_CLIENT_ID`) | **not set** |
| Mail client secret | **not set** |
| Redirect URI (`GOOGLE_REDIRECT_URI`) | `http://localhost:8000/api/google/callback` |
| `GOOGLE_PUBLIC_URL` | not set |
| Frontend return | `http://localhost:5173` |
| Callback path (fixed in code) | `/api/google/callback` |

Client IDs are public by design — they travel in the OAuth URL the browser visits. Secrets are not
reproduced anywhere in this document.

### The consequence of the mail client being unset

`google.constants.ts` falls back to the calendar pair when `GOOGLE_MAIL_CLIENT_ID` is blank:

```ts
export const mailClientId = (): string => env('GOOGLE_MAIL_CLIENT_ID') || clientId();
```

So **both flows currently run through the one project, `485561878286`** — and that project's consent
screen is the Internal one. Fixing that single project fixes Gmail connect and Calendar connect
together.

### Scopes currently requested — unchanged by this work

Calendar (`OAUTH_SCOPES`):

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/calendar.events`

Mail (`MAIL_OAUTH_SCOPES`):

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://mail.google.com/`

`https://mail.google.com/` is what Google requires for SMTP/IMAP with XOAUTH2. It is a **restricted**
scope. Nothing was added and nothing needs to be: the connect failure is about *who may consent*, not
*what is being asked for*.

The authorization request also sends `prompt=select_account consent`, `access_type=offline` and
`include_granted_scopes=true`. It sends **no `hd` parameter** — see below.

---

## The change required

In the Google Cloud console, for project `485561878286`:

1. **APIs & Services → OAuth consent screen → User type: change Internal to External.**
2. Publishing status: while **Testing**, only accounts listed under *Test users* may consent, and
   refresh tokens expire after 7 days. Add the accounts that need to connect as test users, or move
   the app to **In production**.
3. Because `https://mail.google.com/` is a restricted scope, going *In production* for users outside
   your Workspace requires Google's **OAuth verification**, including a security assessment. Until
   that completes, the practical route is External + Testing + explicit test users.

### What this does and does not weaken

Switching User Type to External changes **who may consent to this app**. It does not alter your
Workspace security posture: admin controls, 2-step verification, context-aware access and app-access
control all continue to apply to `@gethomerealty.ca` accounts. An external user consenting grants
this app access to **their own** mailbox only.

If you would rather keep the brokerage's Calendar integration Internal, the cleaner shape is the one
the code already anticipates: create a **second Cloud project** for mail, set that one to External,
and populate `GOOGLE_MAIL_CLIENT_ID` / `GOOGLE_MAIL_CLIENT_SECRET`. The second project must register
the same redirect URI. Both flows share one callback and tell each other apart by the signed state,
not by the URL.

### Redirect URIs to register

| Environment | Authorised redirect URI |
| --- | --- |
| Local development | `http://localhost:8000/api/google/callback` |
| Production | `https://<api-host>/api/google/callback` |

Production must also set `GOOGLE_REDIRECT_URI` (or `GOOGLE_PUBLIC_URL`) to that exact value —
otherwise the URI is derived from the request origin, which is only correct when the API is reached
directly. The registered value and the sent value must match Google byte for byte.

---

## Why no application code was changed

The brief asked not to remove the restriction in application code. There was nothing to remove:

- **No `hd` (hosted-domain) parameter** is sent on either authorization URL. Already asserted by
  `oauth-account-picker.spec.ts`.
- **No domain comparison** exists anywhere on the connect path. The only `gethomerealty.ca` strings in
  the server are email signatures, a deals inbox constant and a form placeholder.
- The mailbox row is built from whatever address Google returns, with no inspection of its domain.

Adding a code-side workaround would have been the wrong fix twice over: it could not lift Google's
refusal, which happens before the redirect, and it would have hidden the real cause.

---

## Verification performed

New suite `server/src/google/external-google-account-connect.spec.ts`, 11 tests, covering the
scenarios in the brief:

| Scenario | Result |
| --- | --- |
| A — Workspace address connects | pass |
| B — external `@gmail.com` connects, stored identically | pass |
| C — another external Google domain connects | pass |
| D — reconnect keeps one row; a reconnect with no new token keeps the credential | pass |
| E — no email address, and no refresh token: refused, nothing stored | pass |
| F — cancelled consent stores nothing | covered by `oauth-account-picker.spec.ts` |
| G — same address connected by another user cannot touch the first user's row | pass |

Also pinned: the refresh token is stored encrypted and never in the clear; the mailbox carries the
area it was connected in; the first account in an area becomes the default sender and a later one
does not.

**Negative control:** adding a `@gethomerealty.ca` check to the connect path fails 9 of the 11 tests,
and case A correctly still passes. The suite would catch anyone reintroducing a domain restriction.

Suite runs: 410 tests across 33 suites (`src/google`, `src/email`, `src/inbox`) — all passing. Server
and client typecheck and build clean. No mail was sent: the mailer diverts in development, and
nothing in these tests reaches Google.

---

## What cannot be verified from here

Scenarios A, B and C were verified at the **storage layer** — what the application does with the
result of a completed OAuth. The live round-trip through Google's consent screen cannot be exercised
until the console setting is changed, because that is precisely the step being blocked.

Once the User Type is External, connect a controlled test mailbox and confirm: the account appears
under the right area, a send leaves from it, and inbound sync fetches. Do not use a real client
mailbox for that.
