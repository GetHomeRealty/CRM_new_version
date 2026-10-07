import { LeadsService } from './leads.service';
import type { AuthUserRecord } from '../auth/auth.types';
const admin = { id: 1, role: 'admin', name: 'Admin' } as AuthUserRecord;
function fixture() {
  const lead = { id: 5, name: 'Fixture', deleted_at: null, owner_user_id: null, assigned_to: 2, team_id: null, assigned_team_lead_id: null, collaborator_user_ids: [3] };
  const prisma = { leads: { findFirst: jest.fn().mockResolvedValue(lead), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, users: { findFirst: jest.fn().mockResolvedValue({ id: 4 }) } };
  const audit = { record: jest.fn() };
  return { lead, prisma, audit, service: new LeadsService(prisma as never, audit as never, {} as never, {} as never, {} as never, {} as never) };
}
describe('collaborator management', () => {
  it('adds an active collaborator without changing owner or agent and records the change', async () => {
    const f = fixture(); await f.service.changeCollaborator(5, 4, 'add', admin);
    expect(f.prisma.leads.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { collaborator_user_ids: [3, 4], updated_at: expect.any(Date) } }));
    expect(f.audit.record).toHaveBeenCalled();
  });
  it('removes only the requested collaborator, including inactive former users', async () => {
    const f = fixture(); await f.service.changeCollaborator(5, 3, 'remove', admin);
    expect(f.prisma.users.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.leads.updateMany.mock.calls[0][0].data.collaborator_user_ids).toEqual([]);
  });
  it('does not let a collaborator share a lead further', async () => {
    const f = fixture(); await expect(f.service.changeCollaborator(5, 4, 'add', { id: 3, role: 'agent' } as AuthUserRecord)).rejects.toThrow(/Only the lead owner/);
    expect(f.prisma.leads.updateMany).not.toHaveBeenCalled();
  });
  it('permits a private owner to manage collaborators', async () => {
    const f = fixture(); f.lead.owner_user_id = 3 as never;
    await expect(f.service.changeCollaborator(5, 4, 'add', { id: 3, role: 'agent' } as AuthUserRecord)).resolves.toEqual({ saved: true });
  });
  it('refuses an inaccessible lead', async () => {
    const f = fixture(); f.prisma.leads.findFirst.mockResolvedValue(null);
    await expect(f.service.changeCollaborator(5, 4, 'add', admin)).rejects.toThrow('Lead not found.');
  });
  it('refuses inactive recipients', async () => {
    const f = fixture(); f.prisma.users.findFirst.mockResolvedValue(null);
    await expect(f.service.changeCollaborator(5, 4, 'add', admin)).rejects.toThrow();
    expect(f.prisma.leads.updateMany).not.toHaveBeenCalled();
  });
  it.each([0, -1, '4', null, 1.5])('refuses malformed recipient %s', async target => {
    const f = fixture(); await expect(f.service.changeCollaborator(5, target, 'add', admin)).rejects.toThrow();
    expect(f.prisma.leads.updateMany).not.toHaveBeenCalled();
  });
  it('refuses redundant assigned-agent membership', async () => {
    const f = fixture(); await expect(f.service.changeCollaborator(5, 2, 'add', admin)).rejects.toThrow();
  });
  it('does not overwrite a concurrent assignment or sharing change', async () => {
    const f = fixture(); f.prisma.leads.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.service.changeCollaborator(5, 4, 'add', admin)).rejects.toThrow(/access changed/);
    expect(f.audit.record).not.toHaveBeenCalled();
  });
  it('is idempotent for an already-added person', async () => {
    const f = fixture(); await f.service.changeCollaborator(5, 3, 'add', admin);
    expect(f.prisma.leads.updateMany).not.toHaveBeenCalled();
  });
});
