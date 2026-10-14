import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
afterAll(() => prisma.$disconnect());

it('persists optional builder project details and allows clearing them', async () => {
  const rollback = new Error('builder-details-test-rollback');
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.transactions.create({ data: {
        trade_no: `BUILDER-TEST-${Date.now()}`, type: 'Preconstruction', agent: 'Test Agent',
        builder_project: 'Sample Project', builder_lot_number: '007-A',
        builder_city: 'Toronto', builder_description: 'Corner lot.\nNear transit.',
      } });
      const saved = await tx.transactions.findUniqueOrThrow({ where: { id: row.id } });
      expect(saved.builder_project).toBe('Sample Project');
      expect(saved.builder_lot_number).toBe('007-A');
      expect(saved.builder_city).toBe('Toronto');
      expect(saved.builder_description).toBe('Corner lot.\nNear transit.');
      const cleared = await tx.transactions.update({ where: { id: row.id }, data: {
        builder_lot_number: null, builder_city: null, builder_description: null,
      } });
      expect(cleared.builder_lot_number).toBeNull();
      expect(cleared.builder_city).toBeNull();
      expect(cleared.builder_description).toBeNull();
      expect(cleared.builder_project).toBe('Sample Project');
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
});
