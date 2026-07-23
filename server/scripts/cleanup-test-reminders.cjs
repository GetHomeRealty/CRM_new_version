/**
 * One-off cleanup: remove the reminder log rows and reminder flags created while verifying
 * the reminder feature, so production starts with a clean reminder history.
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const rows = await p.document_reminders.findMany({ select: { document_id: true } });
  const docIds = [...new Set(rows.map((r) => r.document_id).filter((id) => id != null))];
  console.log(`removing ${rows.length} reminder log row(s), resetting ${docIds.length} document flag(s)`);

  const del = await p.document_reminders.deleteMany({});
  const upd = await p.documents.updateMany({ where: { id: { in: docIds } }, data: { reminder: false } });
  // import batches created by verify-import are test artifacts too
  const batches = await p.import_batches.deleteMany({});

  console.log('deleted log rows :', del.count);
  console.log('flags reset      :', upd.count);
  console.log('batches removed  :', batches.count);
  console.log('remaining logs   :', await p.document_reminders.count());
  console.log('documents flagged:', await p.documents.count({ where: { reminder: true } }));
  await p.$disconnect();
})();
