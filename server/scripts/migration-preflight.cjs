/**
 * Is this database ready for the 2026-08-03 migrations?
 *
 * WHY THIS EXISTS. Two of those migrations add constraints that existing rows can violate:
 *
 *   20260803000000_users_ci_unique   — unique indexes on lower(email) and lower(username)
 *   20260803010000_person_user_ids   — user id columns backfilled from names
 *
 * Both are guarded and will refuse rather than corrupt anything, but "the deploy stopped" is a bad
 * way to find out. This answers the same questions read-only, beforehand, against whatever database
 * you point it at — so a production release is a decision rather than a surprise.
 *
 * READ-ONLY. It runs SELECTs and nothing else. It is safe against production, which is the point.
 *
 *   DATABASE_URL=postgresql://user:pass@host:5432/myapp node scripts/migration-preflight.cjs
 */
const { PrismaClient } = require('@prisma/client');

const URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || '';
if (!URL) {
  console.error('\nSet DATABASE_URL to the database you want to check.\n');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
const q = (sql) => prisma.$queryRawUnsafe(sql);

/** Red means the migration will stop; amber means it will proceed and leave something behind. */
const RED = [];
const AMBER = [];

async function main() {
  const db = (await q('select current_database() d'))[0].d;
  console.log(`\nPre-flight for: ${db}\n${'='.repeat(60)}`);

  const applied = await q(
    "select migration_name from _prisma_migrations where migration_name in ('20260803000000_users_ci_unique','20260803010000_person_user_ids')",
  ).catch(() => []);
  const done = new Set(applied.map((r) => r.migration_name));

  // ---- 20260803000000_users_ci_unique -------------------------------------
  console.log('\n1. users_ci_unique — case-insensitive email and username');
  if (done.has('20260803000000_users_ci_unique')) {
    console.log('   already applied.');
  } else {
    const mail = await q(
      'select lower(email) v, count(*)::int n from users group by lower(email) having count(*) > 1 order by n desc',
    );
    const user = await q(
      'select lower(username) v, count(*)::int n from users where username is not null group by lower(username) having count(*) > 1 order by n desc',
    );
    console.log(`   addresses differing only by case : ${mail.length}`);
    console.log(`   usernames differing only by case : ${user.length}`);
    mail.slice(0, 10).forEach((r) => console.log(`      ${r.v}  ×${r.n}`));
    user.slice(0, 10).forEach((r) => console.log(`      ${r.v}  ×${r.n}`));
    if (mail.length || user.length) {
      RED.push(
        `users_ci_unique will REFUSE to run: ${mail.length} email(s) and ${user.length} username(s) `
        + 'differ only by capitalisation. Merge or rename them first — they are already two accounts '
        + 'for what mail systems treat as one person.',
      );
    } else {
      console.log('   ready.');
    }
  }

  // ---- 20260803010000_person_user_ids -------------------------------------
  console.log('\n2. person_user_ids — identify people by id, not by name');
  if (done.has('20260803010000_person_user_ids')) {
    console.log('   already applied.');
    const left = await q(
      "select count(*)::int n from transactions where agent_user_id is null and agent is not null and agent <> ''",
    ).catch(() => [{ n: 0 }]);
    console.log(`   transactions still on the name fallback: ${left[0].n}`);
  } else {
    const amb = await q(
      "select t.agent, count(distinct u.id)::int c from transactions t join users u on u.name = t.agent "
      + "where t.agent is not null and t.agent <> '' group by t.agent having count(distinct u.id) > 1 order by c desc",
    );
    const unmatched = await q(
      "select t.agent, count(*)::int n from transactions t where t.agent is not null and t.agent <> '' "
      + 'and not exists (select 1 from users u where u.name = t.agent) group by t.agent order by n desc',
    );
    const total = (await q("select count(*)::int n from transactions where agent is not null and agent <> ''"))[0].n;

    console.log(`   transactions naming an agent        : ${total}`);
    console.log(`   names matching MORE THAN ONE user   : ${amb.length}`);
    amb.slice(0, 10).forEach((r) => console.log(`      ${JSON.stringify(r.agent)} → ${r.c} accounts`));
    console.log(`   names matching NO user              : ${unmatched.length}`);
    unmatched.slice(0, 10).forEach((r) => console.log(`      ${JSON.stringify(r.agent)} on ${r.n} deal(s)`));

    // Neither blocks the migration — it backfills only the unambiguous rows on purpose — but both
    // mean those deals keep resolving commission by name, which is the weaker path.
    if (amb.length) {
      AMBER.push(
        `${amb.length} agent name(s) match more than one account. Those transactions will NOT be `
        + 'backfilled — guessing between two candidates is exactly the bug this fixes — and will keep '
        + 'resolving commission by name. Decide who each deal belongs to and set agent_user_id by hand.',
      );
    }
    if (unmatched.length) {
      AMBER.push(
        `${unmatched.length} agent name(s) match no user account at all (a departed colleague deleted, `
        + 'or a typo). Those keep the name fallback, which is what they have today.',
      );
    }
    if (!amb.length && !unmatched.length) console.log('   every agent name resolves to exactly one account — a complete backfill.');
  }

  // ---- context ------------------------------------------------------------
  console.log('\n3. Context');
  const dupNames = await q('select name, count(*)::int n from users group by name having count(*) > 1 order by n desc');
  console.log(`   users sharing a name: ${dupNames.length}`);
  dupNames.slice(0, 10).forEach((r) => console.log(`      ${JSON.stringify(r.name)} ×${r.n}`));
  if (dupNames.length) {
    AMBER.push(
      `${dupNames.length} name(s) are held by more than one account. The Users screen now refuses to `
      + 'create these, but existing ones remain — and every one is a commission split resolved by a '
      + 'name that means two people.',
    );
  }

  console.log(`\n${'='.repeat(60)}`);
  if (RED.length) {
    console.log('\nBLOCKING — fix before deploying:');
    RED.forEach((m) => console.log(`  ✖ ${m}`));
  }
  if (AMBER.length) {
    console.log('\nProceeds, but leaves something behind:');
    AMBER.forEach((m) => console.log(`  ! ${m}`));
  }
  if (!RED.length && !AMBER.length) console.log('\nClear. Both migrations will apply cleanly and backfill completely.\n');
  else console.log('');

  process.exitCode = RED.length ? 2 : 0;
}

main()
  .catch((e) => { console.error('\nPre-flight could not run:', e.message, '\n'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
