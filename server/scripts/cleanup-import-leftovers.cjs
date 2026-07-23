/**
 * Remove transactions left behind by an aborted verify-import run. Only rows whose property
 * address matches the test fixture pattern "<n> Import Way <STAMP>" are touched.
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const rows = await p.transactions.findMany({
    where: { property: { contains: 'Import Way' } },
    select: { id: true, trade_no: true, property: true, created_at: true },
  });
  if (!rows.length) { console.log('no leftovers found'); await p.$disconnect(); return; }
  console.table(rows.map((r) => ({ trade: r.trade_no, property: r.property })));

  const ids = rows.map((r) => r.id);
  await p.audit_logs.deleteMany({ where: { transaction_id: { in: ids } } });
  await p.invoices.deleteMany({ where: { transaction_id: { in: ids } } });
  await p.transaction_statuses.deleteMany({ where: { transaction_id: { in: ids } } });
  await p.team_members.deleteMany({ where: { transaction_id: { in: ids } } });
  await p.documents.deleteMany({ where: { transaction_id: { in: ids } } });
  await p.document_reminders.deleteMany({ where: { transaction_id: { in: ids } } });
  await p.conditions.deleteMany({ where: { transaction_id: { in: ids } } });
  await p.clients.deleteMany({ where: { transaction_id: { in: ids } } });
  const del = await p.transactions.deleteMany({ where: { id: { in: ids } } });

  console.log('deleted transactions:', del.count);
  console.log('remaining live transactions:', await p.transactions.count({ where: { deleted_at: null } }));
  await p.$disconnect();
})();
