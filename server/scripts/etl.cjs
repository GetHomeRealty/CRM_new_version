/**
 * One-time data ETL: copies every domain table from the existing Laravel MySQL
 * database into the new Postgres database, preserving ids (so FKs line up) and
 * then resetting Postgres sequences. Idempotent — truncates the Postgres domain
 * tables first, so it can be re-run safely.
 *
 * Laravel infra tables (cache/jobs/migrations/sessions/…) are intentionally NOT
 * copied — they hold no business data.
 *
 *   node scripts/etl.cjs
 */
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');

const MYSQL_URL = process.env.MYSQL_URL || 'mysql://root@127.0.0.1:3306/myapp';

// Parents before children (Postgres enforces FKs during insert).
const ORDER = [
  'users',
  'agents',
  'customers',
  'company_settings',
  'mail_accounts',
  'transactions',
  'user_permissions',
  'transaction_message_reads',
  'transaction_messages',
  'transaction_statuses',
  'transaction_snapshots',
  'transaction_delete_requests',
  'transaction_edit_requests',
  'trashed_row_items',
  'audit_logs',
  'brokerages',
  'brokerage_agents',
  'clients',
  'client_identifications',
  'conditions',
  'documents',
  'inter_board_listings',
  'precon_terms',
  'team_members',
  'team_member_terms',
  'invoices',
  'invoice_line_items',
  'invoice_payments',
  'email_templates',
];

async function main() {
  const my = await mysql.createConnection({
    uri: MYSQL_URL,
    // Interpret MySQL DATETIME/DATE values as UTC (Laravel stores naive UTC), so
    // Postgres receives the same wall-clock instead of a local-tz-shifted one.
    timezone: 'Z',
    // Coerce MySQL tinyint(1) → JS boolean so it matches the Prisma Boolean columns.
    typeCast(field, next) {
      if (field.type === 'TINY' && field.length === 1) {
        const v = field.string();
        return v === null ? null : v === '1';
      }
      return next();
    },
  });
  const prisma = new PrismaClient();

  try {
    // Clean slate (children first via CASCADE) so re-runs are safe.
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${ORDER.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );

    const summary = [];
    for (const table of ORDER) {
      const [rows] = await my.query(`SELECT * FROM \`${table}\``);
      if (rows.length > 0) {
        // Column names are identical between the MySQL table and the Prisma model,
        // so rows map straight into createMany (relation fields aren't columns).
        await prisma[table].createMany({ data: rows });
        // Reset the id sequence past the largest imported id.
        await prisma.$executeRawUnsafe(
          `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), (SELECT COALESCE(MAX(id), 1) FROM "${table}"))`,
        ).catch(() => { /* tables without an id sequence (none here) */ });
      }
      summary.push(`${table.padEnd(30)} ${rows.length}`);
    }

    // eslint-disable-next-line no-console
    console.log('ETL complete — rows copied:\n' + summary.join('\n'));
  } finally {
    await my.end();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('ETL failed:', e);
  process.exit(1);
});
