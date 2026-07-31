# User Acceptance Testing

Scripts for the people who will actually use Transaction Desk to sign off that it works — an
administrator, a transaction coordinator, and an agent.

These are **not** developer tests. The automated suite already proves the code does what the code
was written to do. UAT answers a different question: *does the brokerage's real work fit through
this software?* Only somebody who does that work can answer it, which is why every step below is
written in the vocabulary of the job rather than the vocabulary of the system.

## How to run a session

**Use a copy, not production.** Restore the latest backup into a scratch database and point a test
instance at it (`docs/DISASTER-RECOVERY.md` → *Restoring*). UAT means people trying things, getting
them wrong, and trying again. That is the point, and it is not something to do to live commission
records.

**One tester, one script, one sitting.** Roughly 45–60 minutes each.

**Watch, do not coach.** If a tester cannot find something, that is the finding. Write down where
they looked first. The instinct to say "it's under Settings" destroys the only data the session was
going to produce.

**Record every step as one of:**

| | |
|---|---|
| **Pass** | Did what the tester expected, without help |
| **Pass with friction** | Worked, but took a wrong turn, hesitated, or needed a second look — *write down where* |
| **Fail** | Wrong result, error, or could not complete |
| **Blocked** | Could not attempt — note why |

"Pass with friction" is the most valuable column and the one people skip. A step that is technically
correct but that three of four testers stumble on is a real defect in a product agents use every day.

**Sign-off requires:** zero Fails on steps marked **critical**, and an agreed disposition (fix now /
fix later / accept) for everything else.

---

# Script A — Administrator

**Who:** the broker of record or office administrator.
**Before you start:** signed in as an administrator.

### A1 · Bring a new agent onto the team — *critical*

The single most common administrative task, and the one where a mistake locks a colleague out.

1. Create a new user for a new agent. Give them the **Agent** role.
2. Set their commission split to whatever your office actually uses for a new agent.
3. Save, then find that agent in the user list.
4. Send them the onboarding email. Check the preview before sending — **is it addressed correctly,
   and is the address on the letterhead right?**
5. Attach the contract and send it.

> Confirm explicitly: does the address shown on the onboarding email and contract match the address
> in Settings? These have been known to disagree, and it goes out to every new hire.

**Watch for:** whether the tester can tell, from the user list alone, that the contract has been
sent and not yet returned.

### A2 · Someone leaves — *critical*

1. Pick a test agent who owns at least one lead and one transaction.
2. Deactivate them.
3. Confirm they can no longer sign in.
4. Confirm their transactions are still visible to you, with history intact.
5. Transfer their leads to another agent. Confirm the receiving agent can see them and the
   deactivated agent no longer can.

> **This is the step most likely to expose a real problem.** Agents leave brokerages regularly and
> their pipeline has to survive it. If a lead becomes invisible to everyone, that is a Fail, not a
> quirk.

### A3 · Change what a role can do — *critical*

1. Open role permissions.
2. Remove one screen from the **Agent** role.
3. Sign in as an agent (second browser or private window) and confirm the screen is gone.
4. Put it back. Confirm it returns without a restart.

> **Do not skip step 4.** A permission you cannot restore is a lockout.

### A4 · The month-end numbers

1. Open the commission report for the current month.
2. Open the invoice list for the same period.
3. **Do the totals agree with each other, and with what you believe is true?**
4. Export both. Open the exports outside the application.

> Ask the tester to check the arithmetic on one transaction by hand. A report that is beautiful and
> wrong is worse than no report.

### A5 · Company settings

1. Change the company address. Save. Reload.
2. Confirm the new address appears on a newly generated document — not just in the settings form.

---

# Script B — Transaction Coordinator

**Who:** whoever takes a deal from accepted offer to closed.
**Before you start:** signed in with the transaction coordinator / documentation role.

### B1 · Open a new deal — *critical*

1. Create a transaction for a property you know.
2. Enter the buyer, seller, price, and both key dates.
3. Assign the agent.
4. Save and reopen it. **Is everything you typed still there?**

> The screen auto-saves as you type. Ask the tester to change a field and navigate away *without*
> pausing — then come back and check it saved. This is where auto-save bugs surface.

### B2 · Documents — *critical*

1. Upload three documents of the kinds you handle daily.
2. Mark one as received and one as still outstanding.
3. Find, from the transaction, what is still missing.
4. Download one you uploaded and confirm it is the right file.
5. Delete one and confirm it goes where you expect and can be recovered.

### B3 · Chase what is outstanding

1. From the main transaction list, identify every deal with a missing document.
2. Do the same for deals closing in the next two weeks.

> **Can the tester do this without opening each deal one at a time?** If not, say so — that is the
> difference between a system that saves time and one that costs it.

### B4 · Talk to the agent

1. Send a message on the transaction.
2. Confirm the assigned agent sees it and gets notified.
3. Reply as the agent. Confirm the coordinator sees the reply.

### B5 · Close it — *critical*

1. Take a transaction to closed.
2. Confirm the commission calculates as expected.
3. Generate the invoice.
4. **Check the invoice arithmetic by hand.**
5. Confirm the closed deal appears in this month's report.

> Have the tester compare against a real closed deal they remember. Known open question: three terms
> in the signed contract are not implemented in the commission engine — if the tester's expectation
> disagrees with the software here, capture the detail rather than assuming it is tester error.

---

# Script C — Agent

**Who:** a working agent. Ideally two testers: one comfortable with software, one not.
**Before you start:** signed in as an agent with existing leads.

### C1 · The morning look — *critical*

Sign in and, **without being told where to go**, answer:

1. How many new leads do I have?
2. What is closing this month?
3. What does the brokerage owe me?

> Note where they look first for each. Time each one. If any takes more than about 30 seconds on a
> screen they use daily, record it as friction even if they get there.

### C2 · A new lead arrives — *critical*

1. Add a lead by hand.
2. Log a call and note the outcome.
3. Set a follow-up.
4. Move it to the next stage.
5. Find it again tomorrow — i.e. show where it would appear in a follow-up list.

### C3 · My leads are mine — *critical*

**This is the confidentiality rule the brokerage runs on. Test it properly.**

1. As agent A, confirm you see only your own leads and any assigned to you.
2. Have agent B sign in elsewhere. Confirm B **cannot** see A's leads.
3. Assign one of A's leads to B. Confirm **both** now see it.
4. As B, try to change that lead's name, email, or phone. **This should be refused** — only the
   owner may change identity fields.
5. As B, add a note or log a call on it. **This should work.**
6. As B, try to delete it. **This should be refused.**

> Steps 4 and 6 are the ones to get right. If either succeeds, stop and report it — the rule exists
> so that an agent's book of business cannot be taken or damaged by a colleague.

### C4 · Campaign templates

1. Create your own email template. Confirm you can edit and delete it.
2. Open one of the six built-in templates. **You should be able to use it but not edit or delete it.**
3. Confirm you cannot see templates created by another agent.

### C5 · My deal

1. Open one of your transactions.
2. Upload a document.
3. Message the coordinator.
4. Check your commission on it.
5. Confirm you cannot see a transaction that is not yours.

### C6 · On a phone — *critical*

Repeat **C1** and **C2** on an actual phone, not a resized browser window.

> Agents work from cars and open houses. If this is unusable on a phone, that is a release-blocking
> finding regardless of how the desktop scores.

---

## Recording the session

One row per step.

| Step | Result | Where they looked first / what went wrong | Severity |
|---|---|---|---|
| A1 | Pass with friction | Looked in Settings for "add user" before finding it under Users | Minor |

**Severity:** *Blocker* (cannot go live) · *Major* (go live, fix immediately) · *Minor* (schedule it)
· *Cosmetic*.

Any **critical** step that Fails is a Blocker until argued otherwise in writing.

## Sign-off

> We have run scripts A, B and C against a copy of production data. All critical steps pass. The
> findings below are recorded with an agreed disposition. We accept this release for production use.
>
> Administrator ................................ Date ..........
> Transaction coordinator ...................... Date ..........
> Agent ........................................ Date ..........
