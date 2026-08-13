#!/usr/bin/env node
/**
 * Move the per-user CRM greeting switches from `crm_trigger_settings` into
 * `notification_preferences`, so that one table owns every per-user CRM communication preference.
 *
 *   node scripts/migrate-crm-greeting-prefs.cjs            # DRY RUN — reads only, writes nothing
 *   node scripts/migrate-crm-greeting-prefs.cjs --apply    # performs the migration
 *   node scripts/migrate-crm-greeting-prefs.cjs --json     # machine-readable summary
 *
 * WHAT MOVES, AND WHAT DOES NOT
 *
 *   birthday, anniversary, seasonal  -> notification_preferences (category `crm_<key>`, channel
 *                                       `email`). These are automated CRM communications and
 *                                       belong with the other per-user preferences.
 *
 *   wedding                          -> NOT migrated. It is being retired as a communication, and
 *                                       carrying a preference across for something that is going
 *                                       away would create a row nobody can explain later. Reported
 *                                       below so the value is visible before it is dropped.
 *
 *   promotional, referral, custom    -> NOT migrated. These are emails a person sends by hand from
 *                                       CRM Settings, not automated communications. They keep their
 *                                       existing switches; only where they are SHOWN changes later.
 *
 * WHY THIS RUNS BEFORE ANY SEND-PATH CHANGE. The moment the send path starts reading
 * `notification_preferences` for greetings, an agent whose row has not been migrated silently
 * reverts to the default. For someone who switched greetings OFF that means client email resuming
 * without their consent — a CASL problem, not a cosmetic one. Data first, reads second.
 *
 * IDEMPOTENT. A row that already holds the intended value is left alone and counted as "already
 * correct". Running twice writes nothing the second time.
 *
 * CONFLICTS STOP THE RUN. If both stores hold a value for the same user and event and they
 * disagree, nothing is written — not even the rows that would have been fine. A conflict means the
 * two stores have diverged and somebody has to decide which is right; picking one silently is how
 * a preference somebody set gets quietly discarded. Re-run once the conflict is resolved.
 */
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');

/** Greeting trigger key -> the notification_preferences category it becomes. */
const MIGRATE = {
  birthday: 'crm_birthday',
  anniversary: 'crm_anniversary',
  seasonal: 'crm_seasonal',
};
/** Present in crm_triggers, deliberately not migrated. Reported, never written. */
const RETIRED = ['wedding'];
const MANUAL = ['promotional', 'referral', 'custom'];
/** The six CRM categories already in notification_preferences; counted to prove they survive. */
const EXISTING_CRM = ['lead_new', 'lead_assigned', 'lead_task_due', 'lead_meta', 'campaign_completed', 'campaign_failed'];

const CHANNEL = 'email';
const prisma = new PrismaClient();

const log = (...a) => { if (!JSON_OUT) console.log(...a); };

async function main() {
  const db = (process.env.DATABASE_URL || '').split('/').pop()?.split('?')[0] ?? '(unknown)';
  log('');
  log('==========================================================');
  log(`  CRM greeting preference migration — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  log(`  database: ${db}`);
  log('==========================================================');

  // ---------------------------------------------------------------- before
  const beforeTotal = await prisma.notification_preferences.count();
  const beforeCrm = await prisma.notification_preferences.count({ where: { category: { in: EXISTING_CRM } } });
  const beforeGreetings = await prisma.notification_preferences.count({ where: { category: { in: Object.values(MIGRATE) } } });

  const triggerRows = await prisma.crm_trigger_settings.findMany({ orderBy: { user_id: 'asc' } });

  const planned = [];        // { user_id, key, category, value }
  const alreadyCorrect = [];
  const conflicts = [];
  const unreadable = [];
  const retiredFound = [];
  const manualFound = [];

  for (const row of triggerRows) {
    let parsed;
    try {
      parsed = row.template_toggles ? JSON.parse(row.template_toggles) : {};
    } catch {
      unreadable.push(row.user_id);
      continue;
    }

    for (const key of RETIRED) {
      if (typeof parsed[key] === 'boolean') retiredFound.push({ user_id: row.user_id, key, value: parsed[key] });
    }
    for (const key of MANUAL) {
      if (typeof parsed[key] === 'boolean') manualFound.push({ user_id: row.user_id, key, value: parsed[key] });
    }

    for (const [key, category] of Object.entries(MIGRATE)) {
      const value = parsed[key];
      if (typeof value !== 'boolean') continue;   // never set — inherits, nothing to move

      const existing = await prisma.notification_preferences.findUnique({
        where: { user_id_category_channel: { user_id: row.user_id, category, channel: CHANNEL } },
      });

      if (!existing) { planned.push({ user_id: row.user_id, key, category, value }); continue; }
      if (existing.enabled === value) { alreadyCorrect.push({ user_id: row.user_id, key, category, value }); continue; }
      conflicts.push({
        user_id: row.user_id, key, category,
        crm_triggers: value, notification_preferences: existing.enabled,
      });
    }
  }

  // ---------------------------------------------------------------- integrity
  const dupes = await prisma.$queryRawUnsafe(
    `SELECT user_id, category, channel, COUNT(*)::int AS n
       FROM notification_preferences
      GROUP BY user_id, category, channel
     HAVING COUNT(*) > 1`,
  );

  // ---------------------------------------------------------------- report
  log('');
  log('-- source: crm_trigger_settings ------------------------------');
  log(`  rows                                    : ${triggerRows.length}`);
  log(`  users with a greeting override to move  : ${new Set(planned.concat(alreadyCorrect).map((p) => p.user_id)).size}`);
  log(`  unreadable template_toggles JSON        : ${unreadable.length}${unreadable.length ? ` -> users ${unreadable.join(', ')}` : ''}`);
  log('');
  log('-- destination: notification_preferences ---------------------');
  log(`  total rows BEFORE                       : ${beforeTotal}`);
  log(`  existing CRM notification rows (keep)   : ${beforeCrm}`);
  log(`  greeting rows already present           : ${beforeGreetings}`);
  log('');
  log('-- plan -----------------------------------------------------');
  log(`  rows that WOULD BE CREATED              : ${planned.length}`);
  planned.forEach((p) => log(`     user ${String(p.user_id).padEnd(5)} ${p.category.padEnd(18)} ${CHANNEL.padEnd(6)} enabled=${p.value}   (from crm_triggers.${p.key})`));
  log(`  rows already correct (idempotent skip)  : ${alreadyCorrect.length}`);
  alreadyCorrect.forEach((p) => log(`     user ${String(p.user_id).padEnd(5)} ${p.category.padEnd(18)} already enabled=${p.value}`));
  log('');
  log('-- not migrated ---------------------------------------------');
  log(`  retired (wedding) values found          : ${retiredFound.length}`);
  retiredFound.forEach((p) => log(`     user ${String(p.user_id).padEnd(5)} ${p.key} = ${p.value}   [retired — value dropped, recorded here]`));
  log(`  manual email switches left in place     : ${manualFound.length}`);
  manualFound.forEach((p) => log(`     user ${String(p.user_id).padEnd(5)} ${p.key} = ${p.value}   [stays in crm_triggers]`));
  log('');
  log('-- integrity ------------------------------------------------');
  log(`  duplicate (user, category, channel)     : ${dupes.length === 0 ? 'none' : JSON.stringify(dupes)}`);
  log(`  CONFLICTS (stores disagree)             : ${conflicts.length}`);
  conflicts.forEach((c) => log(`     user ${c.user_id} ${c.category}: crm_triggers=${c.crm_triggers} vs notification_preferences=${c.notification_preferences}`));

  const blocked = conflicts.length > 0 || unreadable.length > 0 || dupes.length > 0;

  // ---------------------------------------------------------------- apply
  let created = 0;
  if (APPLY && blocked) {
    log('');
    log('  *** NOTHING WRITTEN. Resolve the items above and run again. ***');
    log('  A conflict means the two stores have diverged; choosing one here would discard a');
    log('  preference somebody set. That decision belongs to a person, not this script.');
  } else if (APPLY) {
    const now = new Date();
    // One transaction: either every preference moves or none does. A half-migrated user is the
    // state the send-path switch cannot reason about.
    await prisma.$transaction(
      planned.map((p) => prisma.notification_preferences.upsert({
        where: { user_id_category_channel: { user_id: p.user_id, category: p.category, channel: CHANNEL } },
        update: { enabled: p.value, updated_at: now },
        create: { user_id: p.user_id, category: p.category, channel: CHANNEL, enabled: p.value, created_at: now, updated_at: now },
      })),
    );
    created = planned.length;
    log('');
    log(`  APPLIED: ${created} preference row(s) written.`);
  } else {
    log('');
    log('  DRY RUN — nothing was written. Re-run with --apply to perform the migration.');
  }

  // ---------------------------------------------------------------- after
  const afterTotal = await prisma.notification_preferences.count();
  const afterCrm = await prisma.notification_preferences.count({ where: { category: { in: EXISTING_CRM } } });
  const afterGreetings = await prisma.notification_preferences.count({ where: { category: { in: Object.values(MIGRATE) } } });

  log('');
  log('-- counts ---------------------------------------------------');
  log(`  notification_preferences total : ${beforeTotal} -> ${afterTotal}   (${APPLY ? 'applied' : 'projected ' + (beforeTotal + planned.length)})`);
  log(`  existing CRM notification rows : ${beforeCrm} -> ${afterCrm}   (must not change)`);
  log(`  greeting rows                  : ${beforeGreetings} -> ${afterGreetings}`);
  log('');
  log(blocked ? '  RESULT: BLOCKED — see conflicts/duplicates above.' : '  RESULT: clean.');
  log('');

  if (JSON_OUT) {
    console.log(JSON.stringify({
      database: db, mode: APPLY ? 'apply' : 'dry-run', blocked,
      trigger_rows: triggerRows.length,
      users_with_greeting_overrides: new Set(planned.concat(alreadyCorrect).map((p) => p.user_id)).size,
      would_create: planned.length, already_correct: alreadyCorrect.length, created,
      conflicts, duplicates: dupes, unreadable,
      retired_found: retiredFound, manual_left_in_place: manualFound,
      before: { total: beforeTotal, crm_notifications: beforeCrm, greetings: beforeGreetings },
      after: { total: afterTotal, crm_notifications: afterCrm, greetings: afterGreetings },
    }, null, 2));
  }

  await prisma.$disconnect();
  // Non-zero on a blocked run so this can gate a deployment step.
  process.exit(blocked ? 2 : 0);
}

main().catch(async (e) => {
  console.error('FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
