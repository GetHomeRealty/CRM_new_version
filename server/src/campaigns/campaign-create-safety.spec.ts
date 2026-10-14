import { CampaignsService } from './campaigns.service';

const user = { id: 7, name: 'Local tester' } as never;
function fixture() {
  const db = {
    campaign_templates: { findFirst: jest.fn().mockResolvedValue({ id: 1, name: 'Test', subject: 'Test', content: 'Test' }) },
    campaigns: { create: jest.fn().mockImplementation(async ({ data }) => ({ ...data, id: 1, recipients: [] })), update: jest.fn(), findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 1, status: 'sending' }) },
  };
  const audience = { resolveRecipients: jest.fn().mockResolvedValue([{ leadId: 1, email: 'test@example.invalid', name: 'Test' }]), newRecipientToken: () => 'test-token' };
  const service = new CampaignsService(db as never, audience as never, { attachmentsForSend: async () => [] } as never, {} as never, {} as never);
  const internals = service as any;
  internals.agentVarsFor = jest.fn().mockResolvedValue({});
  internals.deliver = jest.fn().mockResolvedValue(undefined);
  return { db, audience, service, internals };
}
const input = (scheduled_for: unknown) => ({ name: 'Local test', template_id: 1, scheduled_for, baseUrl: '' } as never);

describe('campaign creation safety (no transport or database)', () => {
  afterEach(() => jest.useRealTimers());
  it.each(['invalid', '2020-01-01T10:00:00Z', '2099-01-01T10:00:00', 123])('rejects explicit invalid schedule %s before any persistence', async value => {
    const f = fixture();
    await expect(f.service.createAndSend(input(value), user)).rejects.toThrow();
    expect(f.db.campaigns.create).not.toHaveBeenCalled();
    expect(f.internals.deliver).not.toHaveBeenCalled();
  });
  it('rejects a schedule that expires while resolving recipients', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const f = fixture();
    f.audience.resolveRecipients.mockImplementation(async () => {
      jest.setSystemTime(new Date('2030-01-01T00:02:00Z'));
      return [{ leadId: 1, email: 'test@example.invalid', name: 'Test' }];
    });
    await expect(f.service.createAndSend(input('2030-01-01T00:01:00Z'), user)).rejects.toThrow('Schedule expired');
    expect(f.db.campaigns.create).not.toHaveBeenCalled();
  });
  it('persists schedule and tracking URL atomically without immediate delivery or later status overwrite', async () => {
    const f = fixture();
    await f.service.createAndSend(input('2099-01-01T00:00:00Z'), user);
    expect(f.db.campaigns.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'scheduled', scheduled_for: new Date('2099-01-01T00:00:00Z'), tracking_base_url: '' }) }));
    expect(f.db.campaigns.update).not.toHaveBeenCalled();
    expect(f.internals.deliver).not.toHaveBeenCalled();
    expect(f.db.campaign_templates.findFirst).toHaveBeenCalledWith({ where: { id: 1, deleted_at: null, is_active: true, OR: [{ user_id: null }, { user_id: 7 }] } });
  });
  it('rejects an unavailable template before creating a campaign', async () => {
    const f = fixture(); f.db.campaign_templates.findFirst.mockResolvedValue(null);
    await expect(f.service.createAndSend(input(null), user)).rejects.toThrow('Template not found');
    expect(f.db.campaigns.create).not.toHaveBeenCalled();
  });
  it.each([null, undefined, ''])('preserves explicit send-now behavior with schedule %s', async schedule => {
    const f = fixture();
    await expect(f.service.createAndSend(input(schedule), user)).resolves.toMatchObject({ id: 1, status: 'sending' });
    expect(f.db.campaigns.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'sending', scheduled_for: null }) }));
    expect(f.internals.deliver).toHaveBeenCalledTimes(1);
  });
});
