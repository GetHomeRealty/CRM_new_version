import { personalAssignment } from './personal-assignment';
import { leadScopeWhere } from '../common/lead-scope';
import { ResourceAccessService } from '../core/resource-access.service';
import type { AuthUserRecord } from '../auth/auth.types';

const privateLead = { owner_user_id: 10, assigned_to: 10, team_id: null, collaborator_user_ids: [] as number[] };
const brokerageLead = { ...privateLead, owner_user_id: null };

describe('personal assignment choices', () => {
  it('keeps the private owner and adds shared editing membership', () => {
    expect(personalAssignment(privateLead, 10, 20, 'keep', false)).toEqual({ collaborator_user_ids: [10] });
  });
  it('defaults changed assignments to keep', () => {
    expect(personalAssignment(privateLead, 10, 20, undefined, false)).toEqual({ collaborator_user_ids: [10] });
  });
  it('does not change retention when editing an unrelated field', () => {
    expect(personalAssignment(privateLead, 10, undefined, undefined, false)).toBeNull();
  });
  it('transfers private ownership only at the owner’s request', () => {
    expect(personalAssignment({ ...privateLead, collaborator_user_ids: [10, 30] }, 10, 20, 'transfer', false))
      .toEqual({ owner_user_id: 20, collaborator_user_ids: [30] });
  });
  it('keeps brokerage ownership for both choices', () => {
    expect(personalAssignment(brokerageLead, 10, 20, 'keep', true)).toEqual({ collaborator_user_ids: [10] });
    expect(personalAssignment({ ...brokerageLead, collaborator_user_ids: [10] }, 10, 20, 'transfer', true))
      .toEqual({ collaborator_user_ids: [] });
  });
  it('does not duplicate retained users', () => {
    expect(personalAssignment({ ...privateLead, collaborator_user_ids: [10] }, 10, 20, 'keep', false))
      .toEqual({ collaborator_user_ids: [10] });
  });
  it('refuses taking another person’s private lead, even for an administrator', () => {
    expect(() => personalAssignment(privateLead, 30, 20, 'transfer', true)).toThrow(/Only the owner/);
  });
  it('refuses unauthorized brokerage routing', () => {
    expect(() => personalAssignment(brokerageLead, 10, 20, 'keep', false)).toThrow(/Only the owner/);
  });
  it.each([null, undefined, 0, -1, 10])('refuses invalid/self recipient %s', (target) => {
    expect(() => personalAssignment(privateLead, 10, target, 'transfer', false)).toThrow();
  });
  it('rejects unknown modes', () => {
    expect(() => personalAssignment(privateLead, 10, 20, 'anything', false)).toThrow();
  });
  it('rejects this mode on team-owned leads', () => {
    expect(() => personalAssignment({ ...brokerageLead, team_id: 5 }, 10, 20, 'keep', true)).toThrow();
  });
  it('does not alter the separate team workflow for legacy requests', () => {
    expect(personalAssignment({ ...brokerageLead, assigned_team_lead_id: 10 }, 10, 20, undefined, true)).toBeNull();
  });
  it('includes retained collaborators in the shared CRM scope', () => {
    expect(leadScopeWhere({ id: 10, role: 'agent' } as AuthUserRecord).OR)
      .toContainEqual({ collaborator_user_ids: { has: 10 } });
  });
  it('keeps activity editing/follow-up access for a collaborator, but denies unrelated agents', async () => {
    const prisma = { leads: { findFirst: jest.fn().mockResolvedValue({ ...privateLead, id: 1, owner_user_id: 20, assigned_to: 20, collaborator_user_ids: [10] }) } };
    const access = new ResourceAccessService(prisma as never);
    await expect(access.assertLead({ id: 10, role: 'agent' }, 1)).resolves.toBeUndefined();
    await expect(access.assertLead({ id: 30, role: 'agent' }, 1)).rejects.toThrow('Lead not found.');
  });
  it('preserves brokerage access after removing personal membership', async () => {
    const prisma = { leads: { findFirst: jest.fn().mockResolvedValue({ ...brokerageLead, id: 1, assigned_to: 20 }) } };
    const access = new ResourceAccessService(prisma as never);
    await expect(access.assertLead({ id: 10, role: 'admin' }, 1)).resolves.toBeUndefined();
    await expect(access.assertLead({ id: 30, role: 'agent' }, 1)).rejects.toThrow('Lead not found.');
  });
});
