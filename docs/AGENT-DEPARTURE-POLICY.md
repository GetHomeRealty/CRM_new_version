# When an agent leaves — what happens to their work

**Decided by:** product, 2026-08-02 · **Applies to:** Users, CRM › Leads, CRM › Meta

Two kinds of lead live in the same table, and they are owned by different people. Everything below
follows from that one distinction.

| | Meta leads | Everything else |
|---|---|---|
| Where they came from | The agent's **own** Meta account, Page, lead form and ad spend | The brokerage — admin/manager assignment, office walk-ins, brokerage campaigns, reception enquiries |
| Who owns them | The agent | The brokerage |
| On departure | **Stay with that agent** | **Return to the brokerage** |
| Can be transferred? | **Never** | Yes, by a Super Admin |

**How the system tells them apart:** `leads.source = 'facebook_meta'`, written only by the Meta
importer. Deliberately *not* `lead_source = 'meta'` — that is a channel somebody typed into a form,
and an agent can record "came from a Facebook ad" on a lead that reached them through the brokerage.
Ownership has to follow the fact the system recorded, not the label a person chose.

---

## Deactivating an agent

Saving a user as **Inactive** does all of this, in this order:

1. **The account is switched off first.** Nothing below can block or delay it — an agent who leaves
   badly is exactly when an administrator cannot be made to wait on a Meta API call.
2. **Meta is disconnected.** Stored access tokens are erased, the agent's lead-form claims are
   released so a successor can connect them, and polling stops.
3. **Brokerage leads return to the brokerage.** They become unowned and unassigned, which is what
   puts them in a Super Admin's view of unattributed intake — the only place anyone can pick them
   up from. An assignment pointing at somebody who has left is cleared whoever owns the lead.
4. **Meta leads are left exactly where they are.** They belong to the agent who generated them.

All of it is written to the audit trail on the `User deactivated` entry, with counts.

### Why steps 2–4 are automatic rather than a checklist

Lead visibility is per person ([`LEAD-PRIVACY-POLICY.md`](LEAD-PRIVACY-POLICY.md)). The moment an
account is switched off its book is visible to **nobody** — not an administrator, not a Super Admin,
who sees unattributed intake (`owner_user_id IS NULL`) rather than another person's book.

So "the administrator can reassign it afterwards" is simply untrue unless the leads are made unowned
at the same moment. Left as a written procedure, the one step people skip is the step that makes
every later step possible. The Users screen still shows what will happen before you save, but it
reports rather than instructs.

### The consequence to accept, stated plainly

**A departed agent's Meta leads are visible to nobody while their account is inactive.** That is the
intended meaning of "personal leads stay with that agent" — they are that agent's property and they
return if the account is reactivated — but those enquiries are not being worked in the meantime and
no screen will show them. If the brokerage ever wants them worked, the decision to make is about
lead ownership, not about this mechanism.

---

## Reactivating an agent

- **Their personal leads come back with them**, because nothing ever moved them.
- **Brokerage leads do not come back.** Anything handed to somebody else is being worked by that
  person now.
- **Meta is *not* reconnected.** The agent signs in to Meta again and a fresh authorisation is
  granted.

Not reconnecting is the deliberate part. A stored credential from before a departure is not one to
trust: access tokens expire, granted permissions change, Pages get removed, and passwords change. A
silent auto-reconnect would either fail confusingly or resume against a stale grant. A fresh OAuth
is the only state anybody can reason about.

There is also nothing to reconnect *to* — the disconnect erased the token — so this is what the
system does rather than a rule it has to remember.

---

## Transferring a book by hand

`Settings › Lead books` moves **brokerage leads only**. Counts on that screen are transferable
counts, and the confirmation says separately how many Meta leads are staying, so the screen cannot
promise more than it delivers.

---

## How each rule is enforced

| Rule | Where | Test |
|---|---|---|
| Deactivation disconnects Meta | `OffboardingService.depart` → `MetaConnectionService.disconnect` | `offboarding.spec.ts` — fails if the disconnect is removed |
| Brokerage leads return to the brokerage | `LeadTransferService.returnToBrokerage` | same |
| Meta leads never move | `source: { not: META_LEAD_SOURCE }` in `returnToBrokerage` and `transfer` | fails if the exclusion is removed |
| Reactivation does not reconnect | Nothing reconnects; the token was erased | asserted directly |
| An inactive account is never polled | `meta-sync-scheduler.service.ts` | fails if the status guard is removed |
| A webhook lead is never written to an inactive account | `meta-sync.service.ts`, recorded `failed` with a reason | fails if the status guard is removed |

The scheduler and webhook guards are a safety net rather than the main mechanism — deactivation
disconnects Meta, so neither should trigger through the UI. They cover connections predating this
change and the case where `depart` could not complete its disconnect, which by design does not abort
the deactivation.

## Related

- [`META-LEAD-FORM-POLICY.md`](META-LEAD-FORM-POLICY.md) — one form belongs to one agent, and how a
  form is released for a successor.
- [`LEAD-PRIVACY-POLICY.md`](LEAD-PRIVACY-POLICY.md) — why a book is invisible to everybody but its
  owner, which is the reason this file has to exist.
