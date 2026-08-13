/**
 * Seeds the QA / staging database with a brokerage that looks like a real one.
 *
 * WHY THIS EXISTS: end-to-end testing means deleting records, breaking workflows and driving the
 * app as six different people. None of that may happen anywhere near the live database, which
 * holds real client identification and real commission figures. This builds an equivalent
 * environment from nothing so those tests have somewhere safe to run.
 *
 *   node scripts/seed-test-env.cjs                        # uses TEST_DATABASE_URL
 *   DATABASE_URL=postgresql://…/myapp_test node scripts/…  # or an explicit one
 *
 * SAFETY: refuses to run unless the database name looks like a test database. That check is the
 * whole reason this is a script and not a handful of psql commands — a mistyped connection string
 * would otherwise seed fake agents and fake deals into production, and the first anyone would know
 * is a client seeing "Test Agent" on a trade record.
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const DB_NAME = (URL.split('/').pop() || '').split('?')[0];

// Belt and braces: the name must say test, and must not say production.
if (!/test|staging|qa|scratch/i.test(DB_NAME) || /prod/i.test(DB_NAME)) {
  console.error(
    `\nRefusing to seed "${DB_NAME || '(no database in URL)'}".\n\n`
    + '  This script writes fake users and fake deals. It only runs against a database whose name\n'
    + '  contains test, staging, qa or scratch — and never one containing "prod".\n\n'
    + '  Set TEST_DATABASE_URL to your QA database and run it again.\n',
  );
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: URL } } });

/** One password for every test account. Fine here, and nowhere else — this database is disposable. */
const PASSWORD = 'TestPass123!';

/**
 * One account per role, so a permission mistake shows up as a person who can see too much rather
 * than as an abstract failing assertion. Labels match the UI, which does not always match the
 * stored key: `admin` is Super Admin and `manager` is Admin, which has caught people out before.
 */
const USERS = [
  { role: 'admin',         name: 'Sam Whitfield',   email: 'superadmin@test.local', label: 'Super Admin' },
  { role: 'manager',       name: 'Priya Raman',     email: 'admin@test.local',      label: 'Admin' },
  { role: 'agent',         name: 'Dana Okafor',     email: 'agent@test.local',      label: 'Agent' },
  { role: 'agent',         name: 'Luis Moreau',     email: 'agent2@test.local',     label: 'Agent (second, for isolation tests)' },
  { role: 'accounting',    name: 'Grace Lindqvist', email: 'accounting@test.local', label: 'Accounting / Finance' },
  { role: 'documentation', name: 'Tomas Iversen',   email: 'docs@test.local',       label: 'Documentation / Office Staff' },
  { role: 'crm',           name: 'Ada Nkemelu',     email: 'crm@test.local',        label: 'CRM' },
];

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
};

async function main() {
  console.log(`Seeding "${DB_NAME}" …\n`);
  const now = new Date();

  // ---- the brokerage itself -------------------------------------------------
  // The brokerage's own record — letterhead, banking, invoice counter. One row, id 1.
  await prisma.company_settings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, name: 'Get Home Realty (QA)', email: 'qa@test.local' },
  });
  console.log('  company_settings … 1');

  // ---- people ---------------------------------------------------------------
  /*
   * The one bcrypt call outside `PasswordHashService`, and it cannot use it: this is a plain
   * CommonJS script, so it can neither import a Nest provider nor resolve ConfigService.
   *
   * It reads the same environment variable instead, with the same default, so a brokerage that
   * raises BCRYPT_ROUNDS does not end up with test fixtures hashed more weakly than the accounts
   * they stand in for — which is the drift this whole change exists to remove.
   */
  const rounds = Number.parseInt(process.env.BCRYPT_ROUNDS ?? '', 10) || 12;
  const hash = bcrypt.hashSync(PASSWORD, rounds);
  const users = {};
  for (const u of USERS) {
    const row = await prisma.users.upsert({
      where: { email: u.email },
      update: { name: u.name, role: u.role, status: 'Active', password: hash },
      create: {
        name: u.name, email: u.email, role: u.role, status: 'Active',
        password: hash, created_at: now, updated_at: now,
      },
    });
    users[u.email] = row.id;
  }
  console.log(`  users … ${USERS.length}`);

  const agent = users['agent@test.local'];
  const agent2 = users['agent2@test.local'];

  // ---- leads ----------------------------------------------------------------
  // Split across the two agents on purpose: the isolation tests need a lead that one agent owns
  // and the other must not be able to reach.
  const LEADS = [
    { name: 'Marcus Bell',      email: 'marcus.bell@example.test',    phone: '416-555-0142', owner: agent },
    { name: 'Yuki Tanaka',      email: 'yuki.tanaka@example.test',    phone: '416-555-0188', owner: agent },
    { name: 'Aisha Rahman',     email: 'aisha.rahman@example.test',   phone: '647-555-0113', owner: agent },
    { name: 'Peter Kowalski',   email: 'p.kowalski@example.test',     phone: '905-555-0177', owner: agent },
    { name: 'Renée Beaulieu',   email: 'renee.beaulieu@example.test', phone: '416-555-0155', owner: agent2 },
    { name: "Fionnuala O'Shea", email: 'f.oshea@example.test',        phone: '647-555-0121', owner: agent2 },
    // Deliberately awkward: a very long name and non-ASCII, so layout and encoding are exercised
    // by the ordinary fixtures rather than only by someone remembering to test them.
    { name: 'Konstantinos Papadopoulos-Winterbourne III', email: 'k.papadopoulos@example.test', phone: '416-555-0199', owner: agent },
    { name: '李 明 (Li Ming)',  email: 'li.ming@example.test',        phone: '905-555-0166', owner: agent2 },
  ];
  let leadCount = 0;
  for (const l of LEADS) {
    const existing = await prisma.leads.findFirst({ where: { email: l.email } });
    if (existing) continue;
    await prisma.leads.create({
      data: {
        name: l.name, email: l.email, phone: l.phone,
        assigned_to: l.owner, owner_user_id: l.owner,
        created_at: now, updated_at: now,
      },
    });
    leadCount += 1;
  }
  console.log(`  leads … ${leadCount}`);

  // ---- transactions ---------------------------------------------------------
  const TXNS = [
    { trade_no: 'QA-1001', type: 'Residential Sale',   address: '12 Elm Street, Toronto' },
    { trade_no: 'QA-1002', type: 'Residential Lease',  address: '480 King Street W, Unit 1204, Toronto' },
    { trade_no: 'QA-1003', type: 'Residential Listing', address: '77 Maple Grove Ave, Mississauga' },
    { trade_no: 'QA-1004', type: 'Commercial Lease',   address: '2200 Industrial Pkwy, Brampton' },
  ];
  let txnCount = 0;
  for (const t of TXNS) {
    const existing = await prisma.transactions.findFirst({ where: { trade_no: t.trade_no } });
    if (existing) continue;
    await prisma.transactions.create({
      data: { trade_no: t.trade_no, type: t.type, created_at: now, updated_at: now },
    });
    txnCount += 1;
  }
  console.log(`  transactions … ${txnCount}`);

  // ---- calendar -------------------------------------------------------------
  // Past, today and future, because "today" is a boundary several screens compute themselves.
  const EVENTS = [
    { title: 'Showing — 12 Elm Street',      date: day(1),  time: '14:00', user_id: agent },
    { title: 'Closing — 480 King Street W',  date: day(7),  time: '10:30', user_id: agent },
    { title: 'Listing appointment',          date: day(-3), time: '09:00', user_id: agent2 },
    { title: 'Open house',                   date: day(0),  time: '13:00', user_id: agent },
  ];
  let evCount = 0;
  for (const e of EVENTS) {
    const existing = await prisma.calendar_events.findFirst({ where: { title: e.title } });
    if (existing) continue;
    await prisma.calendar_events.create({
      data: { ...e, created_at: now, updated_at: now },
    });
    evCount += 1;
  }
  console.log(`  calendar_events … ${evCount}`);

  // ---- inbox ----------------------------------------------------------------
  // A mailbox with mail already in it, so the Inbox screen has something to show without anyone
  // connecting a real IMAP account. inbound_enabled stays FALSE: nothing here should ever try to
  // reach a mail server.
  let account = await prisma.mail_accounts.findFirst({ where: { from_email: 'dana.okafor@test.local' } });
  if (!account) {
    account = await prisma.mail_accounts.create({
      data: {
        name: 'Dana Okafor (QA)', from_name: 'Dana Okafor', from_email: 'dana.okafor@test.local',
        host: 'smtp.invalid.test', port: 587, username: 'dana.okafor@test.local',
        encryption: 'tls', is_active: true, is_default: true, user_id: agent, scope: 'crm',
        imap_host: null, inbound_enabled: false,
        created_at: now, updated_at: now,
      },
    });
  }

  const MAIL = [
    { uid: 9001, from: 'marcus.bell@example.test',  name: 'Marcus Bell',  subject: 'Re: 12 Elm Street — offer question', body: 'Hi Dana, could you confirm whether the deposit is due on acceptance or within 24 hours? Thanks.' },
    { uid: 9002, from: 'yuki.tanaka@example.test',  name: 'Yuki Tanaka',  subject: 'Viewing availability this weekend',   body: 'Are there any showings available Saturday afternoon? We are free after 2pm.' },
    { uid: 9003, from: 'noreply@mls.example.test',  name: 'MLS Alerts',   subject: 'New listings matching your search',    body: 'Three new listings match the saved search "Mississauga 3-bed".' },
    { uid: 9004, from: 'f.oshea@example.test',      name: "Fionnuala O'Shea", subject: 'Lawyer details for closing',       body: 'Our solicitor is Brennan & Co. I will forward their file reference tomorrow.' },
    { uid: 9005, from: 'aisha.rahman@example.test', name: 'Aisha Rahman', subject: 'Documents signed',                     body: 'The listing agreement is signed and attached.' },
  ];
  let mailCount = 0;
  for (const m of MAIL) {
    const existing = await prisma.inbound_emails.findFirst({ where: { account_id: account.id, uid: m.uid } });
    if (existing) continue;
    await prisma.inbound_emails.create({
      data: {
        user_id: agent, account_id: account.id, uid: m.uid,
        message_id: `<qa-${m.uid}@test.local>`,
        from_email: m.from, from_name: m.name, to_email: 'dana.okafor@test.local',
        subject: m.subject, snippet: m.body.slice(0, 200),
        body_text: m.body, body_html: `<p>${m.body}</p>`,
        // Spread over recent days so ordering and the date column are meaningfully exercised.
        received_at: new Date(Date.now() - m.uid % 10 * 86400000 - 3600000),
        seen: m.uid === 9003, lead_id: null,
        created_at: now,
      },
    });
    mailCount += 1;
  }
  console.log(`  mail_accounts … 1`);
  console.log(`  inbound_emails … ${mailCount}`);

  console.log('\nTest accounts — all share the password below.\n');
  for (const u of USERS) console.log(`  ${u.email.padEnd(26)} ${u.label}`);
  console.log(`\n  password: ${PASSWORD}\n`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
