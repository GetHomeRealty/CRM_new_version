# AI Privacy Review

**Date:** 2026-08-02 · **Scope:** every point in this application where personal information leaves
the brokerage's control and reaches a third-party AI provider.

**Method:** located every outbound call to a model vendor in the server source, then read each call
site to establish exactly what is placed in the request, who can trigger it, whether the disclosure
is consented to, and whether anything records that it happened.

---

## Summary

The application discloses personal information to third-party AI providers in **three** places, not
one. Before this review, **none of the three was switched on deliberately** — each enabled itself as
soon as an API key was present in the environment, and `resolveEmailAi()` accepts any of
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`, so configuring one feature silently
enabled the others. **None of the three wrote anything to the audit trail**, so the question a
privacy officer eventually asks — *did client information go to an AI provider, and whose?* — had no
answer in the system.

The three disclosures are not remotely equivalent in sensitivity, and the one addressed first was
the smallest. That is stated plainly here because it is the most useful finding in this document:

| # | Feature | Sensitivity | What leaves | Gate before | Gate now |
|---|---|---|---|---|---|
| 1 | Lead email drafting | **Low** | Lead's first name, agent's name/email, agent's instruction | none | `AI_EMAIL_DRAFTING` |
| 2 | Calendar follow-up suggestions | **Medium** | Whole appointment record incl. attendees and free-text notes, linked lead name, linked deal address | none | `AI_CALENDAR_SUGGESTIONS` |
| 3 | FINTRAC identity extraction | **High** | **The complete image or PDF of a passport or driver's licence** | none | **still none** |

Feature 3 is the most sensitive disclosure this application makes, by a wide margin, and it is the
one with the least protection around it.

---

## 1. Lead email drafting — LOW

**Where:** [`lead-activity.service.ts`](../server/src/leads/lead-activity.service.ts) `generateEmail`
· triggered by "Draft with AI" on a lead · requires `lead` edit.

**What is sent:** the lead's **first name only**, the agent's name and email, and the plain-language
instruction the agent typed. Deliberately not the rest of the lead row — no email address, phone
number, budget, timeline or property details, none of which the model needs to write a greeting.

**Controls in place:**

- Gated on `AI_EMAIL_DRAFTING=on`. Unset, it answers 503 with an explanation of what enabling it
  would disclose.
- Every draft writes an audit entry naming the provider and model and stating what was sent.
- The lead's name and the agent's name are sanitised (quotes, angle brackets, backticks and
  newlines removed; length capped) and wrapped in `<name>` / `<agent>` delimiters, with the system
  prompt instructing the model to treat their contents as data. A lead name is attacker-controllable
  — Meta lead forms, web enquiries and CSV imports all write it — so a lead called
  `". Ignore previous instructions…` would otherwise be composing the brokerage's prompts.

**Residual risk:** the agent's own instruction is passed through unmodified, by necessity — it is
the input. An agent who types client details into it discloses them. That is a training matter
rather than something the code can prevent without making the feature useless.

**Status: acceptable, once the switch is set knowingly.**

---

## 2. Calendar follow-up suggestions — MEDIUM

**Where:** [`event-suggestions.service.ts`](../server/src/calendar/event-suggestions.service.ts)
`forEvent` · triggered by "Suggest follow-ups" on an appointment.

**What is sent:** considerably more than feature 1 —

- the appointment's title, kind, date, time, status and **location**;
- its **attendees** field, which is free text and in practice holds client names;
- the **description**, the **notes the agent wrote**, and **property details** — all free text, and
  the notes field is where an agent records what a client said;
- the linked lead's **name and status**;
- the linked deal's **trade number and property address**.

The service's own header comment was admirably candid about this, and its final clause was the whole
problem:

> **WHAT LEAVES THE BUILDING.** The prompt carries the appointment's own fields and the linked
> lead's name — client information, sent to whichever provider is configured. Worth knowing before
> this is switched on for a brokerage…

There was nothing to switch on. It ran whenever a key existed — including a key set for an unrelated
feature. **There is now:** `AI_CALENDAR_SUGGESTIONS=on`.

**What it does well:** it refuses to invent a meeting summary, and says why — there is no transcript,
so a "summary" would be fabrication presented to an agent as a record. It fetches only the lead's
name and status rather than the address book entry. That restraint is real and worth keeping.

**Findings, all three now closed** (2026-08-02):

| | | |
|---|---|---|
| **AI-2a** | No consent gate — ran on the presence of any provider key. | **Fixed.** `assertAiFeatureEnabled('calendar-followup-suggestions')`, checked *before* the provider is resolved: "nobody has agreed to send this" and "no API key configured" are different answers, and giving the second when the first is true sends an administrator to fix the wrong thing. |
| **AI-2b** | No audit entry. | **Fixed.** Records through `AiDisclosureService` with the provider, the model, and which fields were *actually populated* — an appointment with no notes discloses less than one with them. |
| **AI-2c** | No prompt-injection handling on `title`, `attendees`, `notes`, `description` or the lead name — all user-writable, some client-reachable via a Meta form. | **Fixed.** Each field goes through `safeForPrompt` with a per-field cap; the record is wrapped in `<record>` … `</record>`; the system prompt declares its contents to be data and instructs the model to ignore anything inside that reads as an instruction. |

The caps are per field and deliberately generous — a note is the one place an agent records what a
client actually said, and truncating it would degrade the suggestions in precisely the case they
are most useful.

---

## 3. FINTRAC identity extraction — HIGH

**Where:** [`id-extraction.service.ts`](../server/src/fintrac/id-extraction.service.ts)
`extractIdFields`, called from `client-identification.service.ts` when an identity document is
uploaded for Form 630.

**What is sent:** **the entire document.** The uploaded image or PDF is base64-encoded and posted to
`api.anthropic.com` in full — not extracted text, the document itself, including the photograph, the
document number, the date of birth and the home address printed on it. The documents in question are
passports, driver's licences and provincial IDs.

This is the most sensitive personal information the brokerage holds, collected under a legal
obligation, from clients who supplied it to satisfy that obligation and not for any other purpose.

**Findings:**

| | |
|---|---|
| **AI-3a** | **No consent gate.** Runs whenever `idExtraction.apiKey` is configured. |
| **AI-3b** | **No audit trail.** Nothing anywhere records that a given client's passport image was transmitted to a third party, or when, or by whom. FINTRAC imposes its own record-keeping duties on identity verification; this disclosure sits outside those records entirely. |
| **AI-3c** | Bypasses the shared provider layer — it calls Anthropic directly rather than through `ai-provider.ts`, so it inherited none of the handling added there and is easy to miss when reviewing "the AI integration". |
| **AI-3d** | No size ceiling on the payload before it is base64-encoded and sent. |

**What it does well:** it never throws — a failure degrades to blank fields and the operator types
them in — and it deliberately does not log field values or image contents.

**Recommended change:** `assertAiFeatureEnabled('fintrac-id-extraction')`, and an audit entry
recording that an identity document for a named client was sent to the provider. Both are small; the
catalogue entry and switch (`AI_ID_EXTRACTION`) already exist.

**Beyond code, this one needs a decision the code cannot make.** Sending identity documents to a
processor outside the brokerage is a disclosure that should be reflected in what clients are told
when their ID is collected, and covered by the agreement with the provider. That is a question for
whoever owns the brokerage's privacy policy, not a configuration flag.

**Not applied.** Deferred by product on 2026-08-02 to the Transaction Desk work, since FINTRAC and
Form 630 belong to that module. Tracked as **B-3**, alongside **B-2** in the same audit.

**The interim mitigation is not the obvious one.** ID extraction has no key of its own —
`configuration.ts` resolves `idExtraction.apiKey` from `ANTHROPIC_API_KEY`, the same variable
`resolveEmailAi()` reads for features 1 and 2. Setting that key to enable AI email drafting
therefore silently re-enables passport uploads. The setting that actually stops it is
`ID_EXTRACTION_PROVIDER=disabled` (any value but `anthropic`), which blocks the call before the
network and leaves the shared key available to the gated features. Confirmed by running the service
with `fetch` stubbed: document transmitted = **no**. Full table in BACKLOG B-3.

---

## The mechanism

[`common/ai-consent.ts`](../server/src/common/ai-consent.ts) holds one catalogue: each feature, the
environment variable that enables it, how sensitive it is, and — in plain words — **what the person
setting that variable is agreeing to send**. `assertAiFeatureEnabled(key)` is the single refusal, and
its message quotes the disclosure back, so an administrator reading a 503 learns what turning it on
would mean rather than just which variable to set.

Three separate `if` statements would have worked. A catalogue was chosen because the question this
document exists to answer — *what does this application send to AI vendors?* — should be answerable
by reading one file, and because the failure being corrected was precisely that each service decided
for itself and none of them decided anything.

An API key still governs whether a feature **can** run. The catalogue governs whether it **may**.

---

## Cross-cutting notes

**Provider selection is implicit.** `resolveEmailAi()` picks the first configured provider in the
order Anthropic → OpenAI → Gemini unless `AI_EMAIL_PROVIDER` pins one. Adding a key for one purpose
therefore changes which company receives data for another. Pinning the provider explicitly in
production is recommended so that the answer to "who has this data?" is a setting rather than an
accident of ordering.

**No data-retention position is recorded.** Whether a provider retains prompts, for how long, and
whether they may be used for training, is governed by the account and plan the API key belongs to —
not by anything in this repository. That belongs in the agreement with the provider, and the
brokerage should confirm it before enabling any of these features.

**Nothing is sent automatically.** All three features are triggered by a person pressing a control.
There is no background job that sends data to a model.

**Every disclosure is recorded in one place.** `AiDisclosureService` writes to `audit_logs` under
`category: 'AI'`, classified `common` so the rows appear in both areas' trails. That is deliberate:
the features sit in different modules — leads is CRM, calendar spans both, FINTRAC is Transaction
Desk — but "what has this brokerage sent to AI vendors, and about whom" is asked from outside all of
them, and filing each disclosure under the module that happened to make the call would scatter the
answer. Filter the Audit Trail by that category to answer an access request.

---

## Recommendations, in order

1. **Decide on feature 3 before anything else.** It is a live disclosure of identity documents with
   no record that it is happening. Either enable it knowingly, with the audit entry in place and the
   client-facing privacy wording updated, or leave `AI_ID_EXTRACTION` unset and have operators enter
   the fields by hand.
2. ~~Wire feature 2 to the catalogue.~~ **Done 2026-08-02** — see above.
3. **Wire feature 3 to the catalogue** during the FINTRAC audit: `assertAiFeatureEnabled(
   'fintrac-id-extraction')` plus an `AiDisclosureService.record` call naming the client whose
   document was sent. Both mechanisms now exist and are in use by the other two features.
4. **Pin `AI_EMAIL_PROVIDER`** in production so the recipient is a decision.
5. **Confirm retention and training terms** with the chosen provider, and record the answer here.
