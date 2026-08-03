# Meta Lead Forms — ownership policy

**Decided by:** product, 2026-08-02 · **Applies to:** CRM › Meta

> Each agent connects their own personal Meta account and their own Lead Forms. Meta Lead Forms are
> unique to that agent and cannot be shared or transferred between CRM users. The system blocks
> duplicate Form IDs to prevent accidental misconfiguration and incorrect lead routing.

This file exists because the rule is deliberate and its consequences are surprising. A future reader
who finds "two agents cannot both connect this form" restrictive should read this before relaxing it.

---

## The shape

```
Agent A                              Agent B
  │                                    │
  ├── Meta account A                   ├── Meta account B
  ├── Facebook Page A                  ├── Facebook Page B
  ├── Lead Forms A                     ├── Lead Forms B
  └── receives A's leads               └── receives B's leads
```

No sharing at any level. Nothing crosses.

## How it is enforced

| Clause | Mechanism | Verified |
|---|---|---|
| One Meta account per agent | `meta_connections.user_id` is `@unique` | schema |
| Forms belong to one agent | `meta_lead_forms_page_form_key` — `UNIQUE (company_id, page_id, form_id) WHERE is_active` | index confirmed present in the database |
| Duplicate Form IDs blocked | Refused at connect time naming the current holder, **and** by the index above | second agent connecting the same form → refused by the database |
| A claim is released on disconnect | `disconnect()` deactivates the connection **and** the agent's forms, in one transaction | `meta-offboarding.spec.ts`, which fails if the form deactivation is removed |
| Leads route to one agent | The webhook resolves exactly one owner; more than one is refused loudly rather than guessed | service probe |
| Leads stay in one book | Meta import matches only within the importing agent's own book | agent B's record untouched by agent A's form |

**Why the index is partial (`WHERE is_active`).** A form somebody connected and later disconnected
must be free for whoever is running it next. A full unique index would let a dead row hold the claim
for ever, and the only remedy would be a database edit.

**Why `company_id` is in the key.** Form ids come from Meta and are unique there, but the table
carries a tenant like every other. Without it, one brokerage's row could block another's — a
cross-tenant failure that would be almost impossible to diagnose from the message.

## What this rule rules out, on purpose

- **Team or co-listing forms.** Two agents working one Page cannot both receive from one form. The
  supported arrangement is a form each.
- **Handing a form over.** There is no transfer operation, by design. The receiving agent connects
  the form themselves after the previous holder disconnects it.
- **An office-wide intake form feeding several agents.** A form has one owner. Routing one form to
  several people is what produced the original defect — the webhook picked an owner arbitrarily, so
  one agent silently received every lead and the other received none while their screen showed the
  form as connected.

## When an agent leaves

**Deactivating the user does this automatically** — see
[`AGENT-DEPARTURE-POLICY.md`](AGENT-DEPARTURE-POLICY.md) for the whole picture, including what
happens to the leads. As far as forms are concerned:

1. Meta is disconnected: tokens erased, connection deactivated, **and their lead forms deactivated**,
   which releases the claim.
2. The successor connects the form themselves. It is free because the uniqueness index is partial.
3. Reactivating the departed agent does **not** reconnect Meta — they sign in to Meta again, because
   tokens expire and permissions change.

The agent's own Meta leads stay with them and are never transferred; brokerage leads return to the
brokerage. That is a lead-ownership rule rather than a form rule, and it lives in the departure
policy.

### It used to be a manual procedure, and the procedure did not work

Worth keeping, because both halves were wrong in ways that looked fine on screen:

- Deactivating a user did not stop their Meta intake at all. The scheduler resolved the owner with
  `users.findUnique`, which returns a deactivated account exactly as it returns an active one, so
  the poll ran on and leads kept landing in a book nobody could open.
- Even doing it by hand failed. `disconnect()` never deactivated the agent's forms — forms do not
  hang off pages by a foreign key, so nothing cascaded — and the claim was never released. See
  **M-H8** in [`audit/CRM-META-AUDIT.md`](audit/CRM-META-AUDIT.md).

> **Step 3 did not work until 2026-08-02.** `disconnect()` deleted the pages and deactivated the
> connection but never touched `meta_lead_forms` — and forms do not hang off pages by a foreign key,
> so nothing cascaded. Every form stayed `is_active` and kept its claim. An agent who left took
> their forms with them permanently: the successor's attempt was refused, naming a colleague who no
> longer worked here, and the only ways out were a database edit or building a new form in Meta and
> abandoning the ad attached to it. Fixed by deactivating the agent's forms in the same transaction;
> covered by `meta-offboarding.spec.ts`, which calls the real service rather than reconstructing it.

**Still tracked as B-5 in [`BACKLOG.md`](BACKLOG.md)** — the procedure above works, but nothing
*enforces* step 1. Whether deactivating a user should disconnect Meta automatically, and what should
happen to leads that arrive before someone does it by hand, is a decision about offboarding rather
than a defect in this rule.

## Related

- Lead visibility is per person, not per role — [`LEAD-PRIVACY-POLICY.md`](LEAD-PRIVACY-POLICY.md).
  That rule is why a departed agent's leads become invisible rather than merely unattended.
- Lead uniqueness is per book — the same person may be a lead of two agents, because they can arrive
  through anybody's ad. See `CRM-MODULE-AUDIT.md`. **These two rules are consistent:** a *person* may
  reach several agents; a *form* belongs to one.
