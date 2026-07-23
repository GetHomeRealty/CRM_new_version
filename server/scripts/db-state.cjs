/** Quick database state check — used to confirm verification left nothing behind. */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  console.log('live transactions :', await p.transactions.count({ where: { deleted_at: null } }));
  console.log('documents         :', await p.documents.count({ where: { deleted_at: null } }));
  console.log('reminder logs     :', await p.document_reminders.count());
  console.log('import batches    :', await p.import_batches.count());
  console.log('docs flagged      :', await p.documents.count({ where: { reminder: true } }));
  console.log('export jobs       :', await p.export_jobs.count());
  console.log('calendar events   :', await p.calendar_events.count({ where: { deleted_at: null } }));
  console.log('leads             :', await p.leads.count({ where: { deleted_at: null } }));
  console.log('campaigns         :', await p.campaigns.count());
  console.log('suppressions      :', await p.email_suppressions.count());
  await p.$disconnect();
})();
