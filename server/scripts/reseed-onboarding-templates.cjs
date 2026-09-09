/**
 * Bring the Onboarding email templates back in line with the code that defines them.
 *
 * WHY THIS EXISTS. `EmailTemplateService.firstOrCreate` seeds a template row only when one is
 * MISSING; once the row exists it is never written again. That is deliberate — it is what stops
 * every deploy from overwriting wording the brokerage edited in Settings → Templates — but it also
 * means a correction made in `mail-event-registry.ts` never reaches a database that already has the
 * row. The correction ships, the deploy succeeds, and the old text keeps going out.
 *
 * That is not hypothetical. `user.onboard_email` carried "#405-218 Export Blvd, Mississauga ON
 * L6R 0M8" — a Brampton postcode on a Mississauga address, contradicting Settings → Company — for
 * three weeks after 9345480 (2026-08-18) fixed it in code, because the row predated the fix.
 *
 * DRY RUN BY DEFAULT. It prints what differs and changes nothing. `--apply` writes.
 *
 * THE RISK THIS SCRIPT CARRIES, stated plainly: it cannot tell a stale row from a deliberate edit.
 * Both look like "database differs from code". Read the dry run before applying, and if a template
 * was intentionally customised on this server, exclude it with --key or re-do that edit afterwards.
 * Every replaced body is written to a timestamped backup file first, so nothing is unrecoverable.
 *
 * Usage, from server/ on the machine whose database you mean to change:
 *
 *   node scripts/reseed-onboarding-templates.cjs                  # dry run, all onboarding events
 *   node scripts/reseed-onboarding-templates.cjs --key user.onboard_email
 *   node scripts/reseed-onboarding-templates.cjs --apply          # write
 *   node scripts/reseed-onboarding-templates.cjs --key user.onboard_email --apply
 *
 * Requires `npm run build` to have been run — the defaults are read from dist/, so the script
 * reseeds the code THIS deployment is actually running, never a stale checkout.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

let MAIL_EVENTS;
try {
  ({ MAIL_EVENTS } = require('../dist/email/mail-event-registry.js'));
} catch {
  console.error('Could not load dist/email/mail-event-registry.js — run `npm run build` first.');
  process.exit(1);
}

/** The Onboarding module's events. Nothing outside this list is ever touched. */
const ONBOARDING_KEYS = [
  'user.onboard_email',
  'user.onboard_email_fresher',
  'user.accounting_onboard_email',
  'user.training_onboard_email',
  'user.contract_agreement',
  'user.listing_media_agreement',
];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const keyArg = args.includes('--key') ? args[args.indexOf('--key') + 1] : null;
if (keyArg && !ONBOARDING_KEYS.includes(keyArg)) {
  console.error(`--key must be one of:\n  ${ONBOARDING_KEYS.join('\n  ')}`);
  process.exit(1);
}
const keys = keyArg ? [keyArg] : ONBOARDING_KEYS;

/** First line that differs, so the dry run says WHAT changed rather than only that it did. */
function firstDifference(a, b) {
  const left = (a || '').replace(/></g, '>\n<').split('\n');
  const right = (b || '').replace(/></g, '>\n<').split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) {
      return { line: i + 1, db: (left[i] ?? '(end)').trim(), code: (right[i] ?? '(end)').trim() };
    }
  }
  return null;
}

const p = new PrismaClient();

(async () => {
  const drifted = [];
  const missing = [];

  for (const key of keys) {
    const meta = MAIL_EVENTS[key];
    if (!meta) { console.log(`SKIP   ${key} — not in the registry on this build`); continue; }

    const row = await p.email_templates.findUnique({
      where: { event_key: key },
      select: { id: true, name: true, subject: true, body_html: true, updated_at: true },
    });

    if (!row) { missing.push(key); console.log(`ABSENT ${key} — no row; it will seed itself on first use`); continue; }

    const bodyDiffers = (row.body_html || '') !== (meta.default_body_html || '');
    const subjectDiffers = (row.subject || '') !== (meta.default_subject || '');

    if (!bodyDiffers && !subjectDiffers) { console.log(`OK     #${row.id} ${key}`); continue; }

    drifted.push({ key, row, meta, bodyDiffers, subjectDiffers });
    console.log(`DRIFT  #${row.id} ${key}  (last saved ${row.updated_at ? row.updated_at.toISOString().slice(0, 10) : 'unknown'})`);
    if (subjectDiffers) {
      console.log(`         subject db  : ${row.subject}`);
      console.log(`         subject code: ${meta.default_subject}`);
    }
    if (bodyDiffers) {
      const d = firstDifference(row.body_html, meta.default_body_html);
      console.log(`         body ${(row.body_html || '').length} chars in db vs ${(meta.default_body_html || '').length} in code`);
      if (d) {
        console.log(`         first difference at fragment ${d.line}:`);
        console.log(`           db   ${d.db.slice(0, 150)}`);
        console.log(`           code ${d.code.slice(0, 150)}`);
      }
    }
  }

  console.log(`\n${drifted.length} drifted, ${missing.length} absent, ${keys.length - drifted.length - missing.length} already correct`);

  if (!drifted.length) { await p.$disconnect(); return; }

  if (!apply) {
    console.log('\nDry run — nothing was written. Re-run with --apply to replace the bodies above');
    console.log('with the code defaults. Read the differences first: a deliberate edit made in');
    console.log('Settings → Templates looks exactly like a stale row from here.');
    await p.$disconnect();
    return;
  }

  // The backup is written BEFORE the first update, not after the last, so an interrupted run still
  // leaves every original recoverable.
  // Named `.backup` so the repository's existing "local deploy backups: never commit" rule already
  // ignores it. A `.json` extension would have left it sitting untracked in `git status`, one
  // `git add -A` from being committed — and the file is a copy of live brokerage correspondence.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.resolve(__dirname, '..', `onboarding-templates-${stamp}.backup`);
  fs.writeFileSync(backupPath, JSON.stringify(
    drifted.map(({ key, row }) => ({ event_key: key, id: row.id, subject: row.subject, body_html: row.body_html })),
    null, 2,
  ));
  console.log(`\nbacked up ${drifted.length} template(s) to ${backupPath}`);

  for (const { key, row, meta } of drifted) {
    await p.email_templates.update({
      where: { event_key: key },
      data: { subject: meta.default_subject, body_html: meta.default_body_html, updated_at: new Date() },
    });
    console.log(`updated #${row.id} ${key}`);
  }

  // Read back rather than trusting the writes, so the script's last word is measured.
  console.log('');
  for (const { key } of drifted) {
    const after = await p.email_templates.findUnique({ where: { event_key: key }, select: { id: true, body_html: true } });
    const same = (after?.body_html || '') === (MAIL_EVENTS[key]?.default_body_html || '');
    console.log(`${same ? 'OK    ' : 'FAILED'} #${after?.id} ${key}`);
  }

  await p.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
