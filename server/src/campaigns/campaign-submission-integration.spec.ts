import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CampaignsService } from './campaigns.service';

// Opt-in, and refuse every database except the named isolated local fixture.
const url = process.env.CAMPAIGN_TEST_DATABASE_URL;
const allowed = url && new URL(url).hostname === '127.0.0.1' && new URL(url).pathname === '/gh_mobile_test';
const suite = allowed ? describe : describe.skip;
suite('durable campaign submissions against isolated PostgreSQL', () => {
  const db = new PrismaClient({ datasources: { db: { url: url || 'postgresql://localhost/unused' } } });
  const keys: string[] = [], ids: number[] = [];
  let templateId: number;
  const user = { id: 1, name: 'Local test', role: 'Agent', user_permissions: [] } as never;
  const input = (key: string) => ({ request_key: key, name: 'ZZMOBILE receipt test', template_id: templateId, scheduled_for: '2099-01-01T00:00:00Z', baseUrl: '' });
  function service() {
    const s = new CampaignsService(db as never, { resolveRecipients: async () => [{ leadId: null, email: 'local@example.invalid', name: 'Local' }], newRecipientToken: randomUUID } as never, { attachmentsForSend: async () => [] } as never, {} as never, {} as never);
    (s as any).agentVarsFor = async () => ({});
    (s as any).deliver = jest.fn().mockResolvedValue(undefined);
    return s;
  }
  beforeAll(async () => {
    const t = await db.campaign_templates.create({ data: { name: 'ZZMOBILE receipt template', subject: 'Test only', content: 'Never deliver', category: 'custom', user_id: 1, is_active: true } });
    templateId = t.id;
  });
  afterAll(async () => {
    const receipts = await db.campaign_submissions.findMany({ where: { user_id: 1, request_key: { in: keys } } });
    const campaignIds = [...new Set([...ids, ...receipts.map(r => r.campaign_id)])];
    await db.campaign_recipients.deleteMany({ where: { campaign_id: { in: campaignIds } } });
    await db.campaigns.deleteMany({ where: { id: { in: campaignIds } } });
    await db.campaign_submissions.deleteMany({ where: { user_id: 1, request_key: { in: keys } } });
    if (templateId) await db.campaign_templates.delete({ where: { id: templateId } });
    await db.$disconnect();
  });
  it('concurrent service instances create one campaign; restart recovery and cancellation find that exact campaign', async () => {
    const key = randomUUID(); keys.push(key);
    const results = await Promise.all(Array.from({ length: 4 }, () => service().createAndSend(input(key), user)));
    const id = Number(results[0].id); ids.push(id);
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    expect(await db.campaign_recipients.count({ where: { campaign_id: id } })).toBe(1);
    expect(await service().recoverSubmission(key, user)).toMatchObject({ id, status: 'scheduled' });
    await expect(service().recoverSubmission(key, { ...user as any, id: 999999 })).rejects.toThrow('No committed');
    await expect(service().createAndSend({ ...input(key), name: 'Different request' }, user)).rejects.toThrow('different campaign');
    await expect(service().cancelScheduled(id, user)).resolves.toEqual({ cancelled: true });
    await expect(service().recoverSubmission(key, user)).resolves.toMatchObject({ id, status: 'draft' });
    await expect(service().cancelScheduled(id, user)).rejects.toThrow();
    // Deleting a campaign does not permit reuse of its key.
    await db.campaign_recipients.deleteMany({ where: { campaign_id: id } });
    await db.campaigns.delete({ where: { id } });
    await expect(service().createAndSend(input(key), user)).rejects.toThrow('removed');
  });
  it('immediate duplicate requests invoke delivery only once', async () => {
    const key = randomUUID(); keys.push(key);
    const services = [service(), service()];
    const results = await Promise.all(services.map(s => s.createAndSend({ ...input(key), scheduled_for: null }, user)));
    ids.push(Number(results[0].id));
    expect(results[0].id).toBe(results[1].id);
    expect(services.reduce((sum, s) => sum + (s as any).deliver.mock.calls.length, 0)).toBe(1);
  });
});
