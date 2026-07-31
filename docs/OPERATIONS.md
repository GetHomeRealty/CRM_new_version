# Operations

Standard procedures for running Transaction Desk. Written for whoever is on the other end of the
phone when an agent says it is broken — assuming they know the brokerage, not this codebase.

Related: [`DISASTER-RECOVERY.md`](DISASTER-RECOVERY.md) (backup and restore), [`UAT.md`](UAT.md)
(acceptance testing), [`MLS_AND_ENV.md`](MLS_AND_ENV.md) (feed and environment variables).

---

## Is it working right now?

Three endpoints, three different questions. Asking the wrong one is how an outage gets reported as
healthy.

| | Answers | Watch it with |
|---|---|---|
| `GET /api/health` | Is the process alive? Touches nothing. | The thing that restarts the app |
| `GET /api/health/ready` | Can it actually serve? Real database round trip, a write to storage, and a check that the permission tables are not empty. | The load balancer |
| `GET /api/health/metrics` | Throughput, latency percentiles, error rate, slowest routes, recent errors. | A person, during an incident |
| `GET /api/health/workers` | Background timers, export queue, per-mailbox sync age, and this process's CPU, memory and event-loop lag. | The monitor |

`/workers` is deliberately **not** part of `/ready`. An API whose Meta sync is stuck still serves
every page correctly and should keep receiving traffic — `/ready` answers "should traffic come
here", `/workers` answers "is everything actually getting done".

**Point the load balancer at `/ready`, not `/health`.** A process that cannot reach its database is
alive and useless; sending it traffic turns a database problem into an outage.

`/ready` checks the permission tables deliberately. Authorization fails **closed**, so an empty
permission table means every request is denied while every process reports perfectly healthy. That
is an outage with no other symptom.

```bash
curl -s localhost:8000/api/health/ready
```

---

## Monitoring

`server/scripts/monitor.mjs` runs the checks above every five minutes and alerts when one changes
state. Register it once, from an **elevated** prompt:

```powershell
cd server
pwsh -File scripts/schedule-monitor.ps1 -Backup E:\backups\transactiondesk -Every 5
pwsh -File scripts/schedule-monitor.ps1 -Status
```

It checks ten things:

| | |
|---|---|
| **liveness** | is the process answering |
| **readiness** | database round trip, storage write, permission tables not empty |
| **error rate** | 5xx as a share of traffic |
| **latency** | p95 |
| **resources** | RSS, sustained CPU, event-loop lag |
| **schedulers** | the four background timers — IMAP poll, Meta sync, export sweeper, lawyer reminders |
| **jobs** | export queue depth, and anything stuck in *Processing* over an hour |
| **mail sync** | every enabled mailbox, named individually |
| **backup** | last successful run, by staleness |
| **disk** | free space on the backup drive |

The middle four are the ones that cannot be noticed any other way. A stuck export job or a mailbox
that stopped syncing produces no error, no 5xx and no user complaint until someone goes looking —
the site serves every page perfectly while nobody's mail has synced for three days. `/api/health/workers`
exposes that state and this is what reads it.

Mailboxes are reported **by name**: one broken mailbox out of five disappears in any aggregate, and
it is somebody's entire inbox.

### Where alerts go

Set these as **machine environment variables**, not in `server/.env`. The monitor deliberately does
not read `.env`: it has to keep working when the application does not, and an alerter that reads its
credentials from the database it is monitoring goes silent exactly when it is needed. (If you put
them in `.env` anyway, the monitor notices and tells you.)

| | |
|---|---|
| `ALERT_WEBHOOK_URL` | Slack or Teams incoming webhook. The simplest thing that works. |
| `ALERT_SMTP_HOST` etc. | `ALERT_SMTP_PORT` `ALERT_SMTP_USER` `ALERT_SMTP_PASS` `ALERT_EMAIL_TO` `ALERT_EMAIL_FROM` |
| `ALERT_HEARTBEAT_URL` | External dead-man's-switch, pinged after each fully healthy run |

Alerts are **also** written to the Windows Application event log under source `TransactionDesk`
(event id 9001), always, regardless of what else is configured. That is the record that survives on
the machine when the network is the thing that broke:

```powershell
Get-EventLog -LogName Application -Source TransactionDesk -Newest 10
```

One command does all of it — stores the setting machine-wide, self-elevates, and sends a test:

```powershell
cd server
pwsh -File scripts/setup-alerts.ps1 -WebhookUrl 'https://hooks.slack.com/services/...'
```

Create the webhook first at **api.slack.com/apps** → your app → *Incoming Webhooks* → *Add New
Webhook to Workspace*. Teams connector URLs work through the same flag.

Email instead, using a dedicated mailbox and an **app password** (never an account password):

```powershell
pwsh -File scripts/setup-alerts.ps1 -SmtpHost smtp.gmail.com `
     -SmtpUser alerts@gethomerealty.ca -SmtpPass '<app password>' -EmailTo info@gethomerealty.ca
```

And the dead-man's-switch, which is the only check that survives this machine being off:

```powershell
pwsh -File scripts/setup-alerts.ps1 -HeartbeatUrl 'https://hc-ping.com/<uuid>'
```

`-Status` shows what is configured (passwords masked), `-Test` re-sends, `-Clear` removes it all.

**It must be Machine scope, not User** — the monitor runs as SYSTEM and cannot see a User-scoped
variable. The script always writes Machine scope and warns if a stray User copy exists, because a
setting that looks correct and is invisible to the task is the worst outcome available here.

If you would rather set it by hand:

```powershell
[Environment]::SetEnvironmentVariable('ALERT_WEBHOOK_URL','https://hooks.slack.com/...','Machine')
```

### Proving delivery works

Do not wait for an incident to discover the webhook URL had a typo:

```powershell
cd server
node scripts/monitor.mjs --test-alert
```

It sends one clearly-labelled test through **every** configured channel and exits `0` only if at
least one external channel accepted it. Run it immediately after setting a URL, and again whenever
the destination changes — a Slack workspace being deleted or a channel archived silently breaks
delivery, and nothing else would tell you.

Both paths were verified end to end against local sinks before shipping, so a failure here is a
configuration problem, not a code one.

**Set `ALERT_HEARTBEAT_URL`.** Everything else runs on this machine, so nothing here can tell you
this machine is switched off — which is precisely when you need to know. An external service that
alerts when the pings *stop* is the only link in the chain that survives the machine dying.

Sign up at **healthchecks.io** (free tier, no card), create a check with a period of 15 minutes and
a grace of 30, copy its ping URL, then:

```powershell
cd server
pwsh -File scripts/setup-alerts.ps1 -HeartbeatUrl 'https://hc-ping.com/<uuid>'
```

**The ping is sent only on a FULLY healthy run** — that inversion is the whole mechanism. If the
application is down, the machine is off, or any one of the ten checks is failing, no ping goes out
and the external service raises the alarm on silence. Verified: two healthy runs pinged, a run with
the application down sent nothing.

Set the check's period comfortably above the monitor's 5-minute interval. Too tight and one slow
run pages somebody; 15/30 tolerates two missed runs before alerting.

### What it will and will not send you

**Silence means healthy.** Alerts fire when a check *changes* to failing, once an hour while it
stays failing, and once when it recovers. A monitor that shouts every five minutes gets muted, and
a muted monitor is worth less than none.

**One cause, one alert.** If the application is down, readiness, error rate and latency cannot be
measured either — those are folded into the liveness alert rather than raised beside it.

**A recovery notice never implies all-clear.** Anything still failing is restated in the same
message.

Two thresholds have a deliberate floor: error rate and latency are not judged until at least 20
requests have been served since startup, because at three requests a single 500 is a 33% error rate
and nobody can act on that at 04:00.

### Reading the task's result code

`schedule-monitor.ps1 -Status` reports the last result, and `0` and `1` mean very different things:

| | |
|---|---|
| `0` | Ran, everything healthy |
| `1` | Ran, **found problems** — this is the monitor *working* |
| anything else | **The monitor itself could not run.** Nothing is being checked. |

The last row is the one to care about. A failing monitor is invisible in exactly the way a failing
backup is, which is what the heartbeat URL is for.

---

## Reading the logs

Every line is one JSON object.

```json
{"t":"2026-07-31T01:48:55.201Z","level":"log","ctx":"HTTP","msg":"GET /api/users 200",
 "req":"c612c38f3e08","user":1,"company":1,"role":"admin","status":200,"ms":3}
```

Every response carries the same id back as the `X-Request-Id` header.

> **When somebody reports a problem, ask for that header.** It is the difference between searching a
> day of logs and reading the exact request. If they cannot find it, ask what time it happened and
> what they were doing, and search on `user` and `path`.

Everything a request touches inherits its `req` id — a warning logged deep inside a service can be
tied back to the click that caused it.

```bash
grep '"req":"c612c38f3e08"' app.log          # one request, end to end
grep '"level":"error"' app.log | tail -50    # what is failing
grep '"company":2' app.log                   # one brokerage
```

**`4xx` is the application saying no** — a permission check, a validation failure — and is normal
traffic. **`5xx` is the application failing** and is the thing worth alerting on. Alert on the rate
of `5xx`, never on `4xx`.

Keys that look like secrets are redacted before writing. Do not defeat this to debug something.

---

## Common requests

### "I can't sign in"

In order:

1. **Is the account active?** A deactivated user gets a refusal that looks like a wrong password.
2. **Have they just tried several times?** Sign-in now allows a whole office to arrive at once
   (120 attempts per 5 minutes from one address by default), but **one account** is locked after
   **8 failed attempts in 15 minutes**, counted wherever they come from. The symptom is `429` with
   a message naming the wait. A correct password clears the record, so this only ever affects
   someone who is genuinely guessing — or someone who has forgotten their password, in which case
   an administrator can reset it and they can sign in immediately.
   Tunable: `AUTH_ACCOUNT_LIMIT_MAX`, `AUTH_ACCOUNT_LIMIT_WINDOW_SECONDS`.
3. **Is everyone affected?** Then it is not the account — check `/api/health/ready`.

### "It says I don't have permission"

Almost always correct behaviour, so establish what should be true before changing anything.

1. What role are they? Administrator → Users.
2. Does that role have the screen? Administrator → Roles & Permissions.
3. If the answer *should* be yes, grant it there. It takes effect immediately — **no restart**.

Two rules that are working as designed and are frequently reported as bugs:

- **An agent cannot see another agent's leads.** Not managers, not the broker — nobody, until the
  lead is assigned to them. This is deliberate and is the rule the brokerage runs on.
- **Only the owner of a lead may change its name, email or phone, or delete it.** An agent it is
  assigned to can do everything else. This is deliberate.

### "A lead disappeared"

Usually ownership, not deletion.

1. Was it assigned to someone else? Then the previous holder stops seeing it — by design.
2. Check the recycle bin.
3. Check the audit log: every ownership transfer is recorded, with who did it and when.

### "Move this agent's leads to somebody else"

Administrator only, and audited. Administrator → Leads → Transfer ownership. Review the counts it
shows you **before** confirming: the operation is recorded but not one-click reversible.

### "The Facebook leads stopped coming in"

1. Administrator → Meta → status.
2. If it says disconnected, reconnect it.

> **Ask who disconnected it.** The `meta.edit` permission is currently granted to the **agent** role,
> which means any agent can disconnect the brokerage's lead-ads integration for everyone. If this
> happens once, that grant is the cause — see *Known operational risks* below.

### "Add a new agent"

Administrator → Users → new user. Role **Agent**. Set the commission split. Then send the onboarding
email and the contract from the user's row — preview both before sending; the address on the
letterhead and the address in Settings have been known to disagree.

---

## Routine

Most of what follows is now checked automatically every five minutes (see *Monitoring*). Keep the
daily glance anyway for the first few weeks — until the alerting has proved itself by catching
something, it is a claim rather than a fact.

### Daily
- Glance at `/api/health/metrics`: error rate and p95 latency.
- Confirm last night's backup succeeded:
  ```powershell
  pwsh -File server/scripts/backup-nightly.ps1 -Status -Out E:\backups\transactiondesk
  ```
  Exit `0` fresh · `1` stale · `2` never succeeded. **A stale heartbeat is an emergency, not a
  chore** — it means the backup is broken whether it errored, never ran, or the machine was off.

### Weekly
- The Sunday scheduled run restores the newest backup into a scratch database automatically. Confirm
  it passed. A backup nobody has restored is a hope.
- Skim the audit log for permission and ownership changes.

### Monthly
- Confirm backups are reaching an **off-machine** location. A backup on the same disk as the
  database survives a mistake, not a fire.
- `npm audit` on `server` and `client`.
- Check database growth (see below).

---

## Deploying

**Never deploy on a Friday, and never during month-end.** Month-end is when commissions are
reconciled and it is the worst possible time for a surprise.

1. **Take a backup and verify it restores.** Not the scheduled one — a fresh one, now.
   ```bash
   cd server && npm run backup && npm run backup:verify
   ```
2. Note the current release, so "roll back" means something specific.
3. Deploy.
4. Run migrations. **`npx prisma migrate deploy` — never `migrate dev`**, which can drop data.
5. `curl /api/health/ready` and confirm every check passes.
6. Sign in as an administrator **and** as an agent. The agent check matters: most authorization
   mistakes are invisible to an administrator, who can see everything anyway.
7. Watch `5xx` rate and p95 for fifteen minutes.

**Rolling back:** redeploy the previous release. If the release included a migration, restoring the
database is the rollback — which is why step 1 is step 1.

The API **refuses to start** with development settings in production and lists exactly what is
wrong. That is a feature. Fix what it names; do not disable the check.

---

## Known operational risks

Live issues to be aware of while operating. Each is real, reproduced, and currently unfixed.

1. **Agents can disconnect the brokerage's Meta integration.** The `agent` role holds `meta.edit`,
   which reaches `DELETE /api/meta/disconnect`. One agent stops lead ingestion for everyone. This is
   a permission grant, changeable in Administrator → Roles & Permissions without a code change.

2. **~~Rate limits sized for one office~~ — resolved.** The general bucket is now keyed by
   signed-in user rather than by IP address, so an office no longer shares one ceiling, and every
   limit is configurable (`.env.example` → *Rate limits*). Sign-in allows a whole office to arrive
   at once, with brute-force protection moved to a **per-account** limit an attacker cannot escape
   by changing address. Verified against a running server: 25 people signing in from one address,
   none blocked; one account locked after 8 failed guesses; a correct password clears the record.

3. **The mail mirror is 96% of the database — retention now available, and OFF by default.**
   `inbound_emails` was 77 MB of an 80 MB database and had doubled in a week. `MAIL_RETENTION_DAYS`
   and `MAIL_STRIP_BODIES_AFTER_DAYS` now exist but both default to keeping everything forever,
   because what may be deleted is a compliance decision rather than a disk-space one — a message
   attached to a deal can be part of the record of that deal. **Nothing is pruned until somebody
   sets these.** Prefer stripping bodies first: it discards nearly all the bytes while keeping the
   message, its sender, its date and its link to a lead. Mail attached to a lead is exempt from
   both unless `MAIL_RETENTION_INCLUDE_LINKED` is set.

4. **Two tenant-isolation defects remain open** (`AUD-001`, `AUD-002`). They do not affect a
   single-brokerage deployment. **They must be fixed before a second brokerage is onboarded** — see
   the audit report. Do not create a second company record until they are closed.

5. **Monitoring exists but must be registered and given a channel.** `schedule-monitor.ps1` runs the
   checks every five minutes; until it is registered from an elevated prompt *and* an alert channel
   is set, problems are detected and then discarded. `schedule-monitor.ps1 -Status` says which of
   those two steps is missing. Set `ALERT_HEARTBEAT_URL` as well — nothing running on this machine
   can report that this machine is off.

---

## Escalation

Before escalating, collect: the `X-Request-Id`, what the user was doing, exact time, their username
and role, and whether anyone else is affected.

| | |
|---|---|
| One user, one screen | Check permissions and role first — usually correct behaviour |
| Everyone, one screen | Application defect — capture a request id and escalate |
| Everyone, everything | Check `/api/health/ready` before anything else |
| Wrong money | **Stop. Do not correct records by hand.** Capture the transaction, expected and actual figures, and escalate. Manual correction destroys the evidence needed to find the cause. |
