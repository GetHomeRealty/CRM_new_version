import { CampaignsService } from './campaigns.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-031: an opt-out given by any means has to be recordable.
 *
 * THE GAP. The only route onto the suppression list was the client clicking the link in an email.
 * A brokerage told "stop emailing me" on the telephone could not comply: the lead's Unsubscribed
 * badge is display-only, the editor has no field for it, and the suppression API offered read and
 * delete and no create. The only way to stop mailing somebody was to keep mailing them until they
 * clicked — which is the opposite of what a withdrawal of consent is supposed to produce, and under
 * Canadian anti-spam law consent may be withdrawn however the person chooses to say it.
 *
 * THE ENFORCEMENT WAS NEVER THE PROBLEM. Once an address is on the list the audience drops it and
 * the per-lead Send button disables itself with a reason. This is only about getting it recorded.
 *
 * THE ASYMMETRY IS THE DESIGN. Recording an opt-out stays on `campaigns:edit`, which an ordinary
 * agent holds; REVERSING one needs the marketing capability (CRM-027). Honouring a request to stop
 * must never be the harder of the two directions — an agent made to find an administrator first is
 * a brokerage that keeps mailing meanwhile.
 */

const AGENT = { id: 9, name: 'Sai Ramesh', role: 'agent' } as unknown as AuthUserRecord;

function svc(existing: Record<string, unknown> | null = null) {
  const writes: { upsert?: Record<string, unknown>; raw?: string } = {};
  const audits: { action: string; subject: string; detail: string }[] = [];

  const prisma = {
    email_suppressions: {
      findUnique: async () => existing,
      upsert: async (a: Record<string, unknown>) => { writes.upsert = a; return a; },
    },
    $executeRaw: async (strings: TemplateStringsArray) => { writes.raw = strings.join('?'); return 1; },
  } as unknown as PrismaService;

  const audit = {
    record: async (_u: unknown, action: string, subject: string, detail: string) => {
      audits.push({ action, subject, detail });
    },
  } as never;

  const s = new CampaignsService(
    prisma, null as never, null as never, null as never, null as never, undefined, audit,
  );
  return { svc: s, writes, audits };
}

describe('staff can record an opt-out received any way', () => {
  it('adds the address, and says so', async () => {
    const h = svc();
    // THE DEFECT: there was no method to call at all.
    await expect(h.svc.addSuppression('caller@probe.invalid', AGENT, 'asked by telephone'))
      .resolves.toEqual({ added: true, already: false });

    const create = (h.writes.upsert as { create: { email: string; reason: string } }).create;
    expect(create.email).toBe('caller@probe.invalid');
    // The reason is kept as given, marked as staff-recorded so the list says how it got there.
    expect(create.reason).toBe('staff: asked by telephone');
  });

  it('flags the matching lead too, not only the suppression list', async () => {
    /*
     * The campaign audience reads BOTH the list and `leads.unsubscribed`; the per-lead Send button
     * reads only the second. Writing one without the other would honour the opt-out in campaigns
     * and leave the lead's own page still offering to email them.
     */
    const h = svc();
    await h.svc.addSuppression('caller@probe.invalid', AGENT);
    expect(h.writes.raw).toMatch(/UPDATE "leads"/);
    expect(h.writes.raw).toMatch(/"unsubscribed" = true/);
  });

  it('normalises the address, so case cannot create a second record', async () => {
    const h = svc();
    await h.svc.addSuppression('  Caller@Probe.INVALID  ', AGENT);
    expect((h.writes.upsert as { where: { email: string } }).where.email).toBe('caller@probe.invalid');
  });

  it('leaves an existing entry exactly as it was', async () => {
    // The FIRST record of an opt-out is the one that matters; overwriting its reason would lose why
    // they originally asked.
    const h = svc({ email: 'caller@probe.invalid', reason: 'unsubscribed' });
    await expect(h.svc.addSuppression('caller@probe.invalid', AGENT, 'again'))
      .resolves.toEqual({ added: true, already: true });
    expect((h.writes.upsert as { update: Record<string, unknown> }).update).toEqual({});
  });

  it('refuses something that is not an address rather than storing it', async () => {
    for (const bad of ['', '   ', 'not-an-email', 'a@b', 'stop emailing me']) {
      await expect(svc().svc.addSuppression(bad, AGENT)).rejects.toThrow(/email address/i);
    }
  });

  it('audits who recorded it, and why', async () => {
    // "Who authorised that, and when" has a legal answer for the reverse direction; the same is
    // worth having for this one.
    const h = svc();
    await h.svc.addSuppression('caller@probe.invalid', AGENT, 'asked at the open house');
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].action).toBe('Opt-out recorded');
    expect(h.audits[0].subject).toBe('caller@probe.invalid');
    expect(h.audits[0].detail).toContain('asked at the open house');
  });
});
