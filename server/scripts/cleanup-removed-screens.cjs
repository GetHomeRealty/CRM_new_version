/**
 * Remove stored permission overrides for the screens that no longer exist
 * (Calendar, Favorites, Inbox, Inventory, Lead, MLS). Leaving them behind would keep
 * dead rows in user_permissions that no screen can ever consume.
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const REMOVED = ['calendar', 'favorites', 'inbox', 'inventory', 'lead', 'mls'];
(async () => {
  const before = await p.user_permissions.count();
  const doomed = await p.user_permissions.findMany({ where: { screen: { in: REMOVED } }, select: { screen: true } });
  console.log(`removing ${doomed.length} override(s) for: ${[...new Set(doomed.map((d) => d.screen))].sort().join(', ') || '(none)'}`);

  const del = await p.user_permissions.deleteMany({ where: { screen: { in: REMOVED } } });
  console.log('deleted        :', del.count);
  console.log('rows before    :', before);
  console.log('rows after     :', await p.user_permissions.count());
  console.log('screens left   :', [...new Set((await p.user_permissions.findMany({ select: { screen: true } })).map((r) => r.screen))].sort().join(', ') || '(none)');
  await p.$disconnect();
})();
