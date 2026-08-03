# Lead Visibility & Privacy Policy

**Status:** Accepted, 2026-08-01
**Applies to:** CRM → Leads, and every screen that counts or lists leads
**Audience:** Broker of Record, compliance, administrators, and anyone auditing this system

This records a deliberate design decision and its consequences, so that neither is discovered for
the first time during an audit, a complaint, or an agent's departure.

Every statement here was **verified at runtime** against the application on 2026-08-01, not read
from source alone. The evidence is in [`docs/audit/CRM-LEADS-AUDIT.md`](audit/CRM-LEADS-AUDIT.md)
and the automated tests in `e2e/tests/leads.spec.ts`.

---

## 1. The policy

> **A lead is visible only to the person it is assigned to and the person who owns it. No role,
> at any rank, grants visibility into a colleague's book.**

This is enforced in one place — [`server/src/common/lead-scope.ts`](../server/src/common/lead-scope.ts) —
which every list, counter, dashboard tile, search and export calls. There is no second
implementation that could drift from it.

A lead is visible to a user when **either**:

- `assigned_to` is that user — the person working it, or
- `owner_user_id` is that user — the person or process that created it.

Plus one narrow exception: a **Super Admin** additionally sees leads where `owner_user_id` is
`NULL` — unattributed intake. This exists so that an import which fails to stamp an owner surfaces
to somebody rather than vanishing. **It does not reveal anyone's book.**

### Verified behaviour

Six roles were signed in and asked for their lead list. Two agents each own part of the seeded
book:

| Role | Stored key | Sees Agent A's leads | Sees Agent B's leads |
|---|---|---|---|
| Agent A | `agent` | Yes | **No** |
| Agent B | `agent` | **No** | Yes |
| Admin | `manager` | **No** | **No** |
| Super Admin | `admin` | **No** | **No** |
| Accounting / Finance | `accounting` | **No** | **No** |
| Documentation / Office Staff | `documentation` | **No** | **No** |

The boundary was probed on **eleven** surfaces and refused on all of them: read, edit, delete,
notes, tasks, tags, calls, email, CSV export, bulk delete, and permanent purge from the recycle
bin. Notably, **an agent's CSV export contains only their own leads** — the rule holds on the way
out of the system, not only on screen.

---

## 2. Why this shape

An agent's book is their relationship with their clients. In a brokerage where agents carry their
own pipeline, "my manager can read all my client conversations by default" is a materially
different product from the one that was built — and the decision was to build this one.

The rule is also written once and applied everywhere, which is what makes it auditable. An earlier
version had the CRM dashboard restating the rule from memory, and the two disagreed in both
directions: an agent who *owned* a transferred lead was not counted, while an administrator's
dashboard read 512 where their Leads screen read 0.

---

## 3. Consequences the business has accepted

These follow directly from the policy. They are not defects; they are the cost of it, and they are
recorded here so nobody is surprised.

### 3.1 No routine managerial oversight

A manager or administrator **cannot** review an agent's pipeline, check whether follow-up is
happening, or investigate a client complaint by looking at the lead record. Supervision has to
happen through conversation, reporting the agent runs themselves, or the escalation path in §4.

### 3.2 No system-wide lead search for compliance

A question of the form *"show me every lead that ever touched this property or this client"*
cannot be answered from the UI by any role. Answering it requires either the escalation path in
§4 or a direct, logged database query performed by an administrator outside the application.

### 3.3 Absence and departure need a deliberate act

If an agent is ill, on leave, or has left the brokerage, their leads are not reachable by anyone
else until ownership is transferred (§4). **A client email sitting in a departed agent's book is
not visible to the office until that transfer happens.** This should form part of the
offboarding checklist and, ideally, the leave process.

### 3.4 Transfer overwrites the previous assignment

The transfer records *that* it happened and *by whom* in the audit trail, but the lead row itself
carries only its current owner. The lead record alone does not show who held it before.

---

## 4. The escalation path — transfer of ownership

The one supported way to reach leads that are not yours.

| Property | Behaviour |
|---|---|
| **Who may use it** | **Super Admin only** — enforced in `lead-transfer.service.ts`, not merely documented. An agent attempting it is refused. |
| **What it does** | Moves an entire book from one person to another. |
| **What it returns** | A **count only** — never the lead data itself. The transferring administrator does not get to read the book as a side effect. |
| **What is recorded** | An `audit_logs` entry naming **both people** and the number of leads moved. |

The design intent, quoted from the code: *"Recovering a departed agent's book must be possible;
doing it quietly must not be."*

**Procedure.** Transfers should be requested in writing, approved by the Broker of Record, and
reconciled against the audit trail periodically. Because it is the only route around the privacy
boundary, it is the control point a regulator would examine.

---

## 5. Audit trail

Lead activity is written to `audit_logs` with `category = 'Lead'` and `transaction_id = NULL`,
readable through the Audit Trail screen. Ownership transfers are recorded there with both names.

### Audit write failures are now detected (fixed 2026-08-01)

`lead-audit.service.ts` catches errors from the audit write and logs a warning rather than failing
the operation:

> `Lead audit write failed (${action}): …`

The trade-off is deliberate — a failed audit write does not roll back the user's work — but the
consequence for compliance is that **the absence of an audit entry does not prove the action did
not occur.** Any non-zero failure count must therefore be treated as an incident requiring
reconciliation of the affected period, not merely as a transient error.

**This is now alerted on.** Failed audit writes are counted in-process, exposed as `audit` on
`GET /api/health/workers`, and checked by `server/scripts/monitor.mjs` (check name: `audit`), which
runs every five minutes and raises through the configured alert channel. The write is still
best-effort — a lead change is never rolled back because the trail failed — but a non-zero
`failures` count now surfaces within minutes instead of never.

---

## 6. Data lifecycle

| Stage | Behaviour |
|---|---|
| **Delete** | **Soft** — `deleted_at` is stamped and `deleted_by` records who. The lead leaves every list and returns 404 on read, but the row and its history remain. |
| **Restore** | Available from the recycle bin, returning the lead to its owner unchanged. |
| **Permanent removal** | Available from the recycle bin, and scoped — **an agent cannot purge another agent's deleted lead** (verified). |
| **Retention** | **There is no automatic lead retention or purge.** Soft-deleted leads are kept indefinitely unless removed by hand. |

The recycle bin is paginated (fixed 2026-08-01), so a soft-deleted lead remains reachable by its
owner regardless of how many there are.

If a retention obligation applies to lead data — CASL, PIPEDA, or brokerage record-keeping rules —
it is **not currently implemented** and must be operated manually.

---

## 7. Review

This policy should be revisited if any of the following change:

- The brokerage takes on a second company record (multi-tenancy) — the scope rule is per-user, not
  per-office, and office-level visibility would be a new decision.
- A regulator or the Broker of Record requires system-wide lead search.
- Team-based selling is introduced, where a lead legitimately belongs to more than one agent.
- An offboarding incident shows the transfer path is too slow in practice.

**Owner:** Broker of Record
**Last verified against the running application:** 2026-08-01
