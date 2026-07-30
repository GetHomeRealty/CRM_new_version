import { PrismaClient } from '@prisma/client';
import { tenantExtension } from './tenant-extension';
import { currentCompanyId, run } from './tenant-context';

const prisma = new PrismaClient();
const scoped = prisma.$extends(tenantExtension(() => scoped)) as unknown as PrismaClient;
const RB = '__rb__';

it('diagnostic in a transaction', async () => {
  try {
    await scoped.$transaction(async (tx) => {
      const now = new Date();
      const co = await tx.company_settings.create({ data: { name: 'Diag Co' } });
      await tx.leads.create({ data: { name: 'theirs', email: 'd@e.test', company_id: co.id, created_at: now, updated_at: now } });
      const all = await tx.leads.count();
      const seen = await run(1, async () => {
        console.log('  in run, ctx =', currentCompanyId());
        return tx.leads.count();
      });
      console.log('  all:', all, ' seen under tenant 1:', seen, ' => filtering:', seen < all ? 'WORKS' : 'NOT APPLIED');
      throw new Error(RB);
    });
  } catch (e) { if (!String((e as Error).message).includes(RB)) throw e; }
  await prisma.$disconnect();
});
