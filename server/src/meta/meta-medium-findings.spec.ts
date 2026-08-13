import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MetaStateService } from './meta-state.service';
import { MetaSyncService } from './meta-sync.service';
import { META_RAW_MAX_CHARS, META_RAW_RETENTION_DAYS } from './meta.constants';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * The MEDIUM findings, against the database rather than a stand-in.
 *
 * M-M1 webhook health was unscoped · M-M2 the replay set emptied itself · M-M4 `meta_raw` was
 * stored whole and kept for ever.
 *
 * The unit-level versions of M-M2 live in `meta.spec.ts` with an in-memory stub. These exist
 * because the guarantee is a UNIQUE INDEX: a stub that models one is only evidence that the stub
 * models one. Same reasoning as M-H8.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const asUser = (id: number, role = 'agent'): AuthUserRecord => ({ id, name: `U${id}`, role } as unknown as AuthUserRecord);
/** Budget and alerts are not exercised by these cases; a permissive stub keeps them out of the way. */
const ALLOW_BUDGET = { consume: async () => ({ allowed: true, spent: 1, limit: 999, resetInSeconds: 60 }) } as never;
const NO_ALERTS = { reconnectRequired: async () => {} } as never;
const syncFor = (tx: PrismaService) =>
  new MetaSyncService(tx, null as never, null as never, null as never, null as never, ALLOW_BUDGET, NO_ALERTS);

async function makeUser(tx: PrismaService, role = 'agent'): Promise<number> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: {
      name: `M ${t}`, email: `m-${t}@example.test`, role, status: 'Active',
      password: 'x', created_at: now, updated_at: now,
    },
  });
  return u.id;
}

async function connectForm(tx: PrismaService, userId: number, formId: string): Promise<string> {
  const now = new Date();
  const pageId = `page-${tag()}`;
  await tx.meta_lead_forms.create({
    data: {
      user_id: userId, page_id: pageId, form_id: formId,
      form_name: 'Campaign', is_active: true, created_at: now, updated_at: now,
    },
  });
  return pageId;
}

async function delivery(tx: PrismaService, formId: string, pageId: string, receivedAt = new Date()): Promise<void> {
  await tx.meta_webhook_events.create({
    data: {
      event_key: `${pageId}:${formId}:${tag()}`, leadgen_id: `lg-${tag()}`,
      form_id: formId, page_id: pageId, status: 'processed', received_at: receivedAt,
    },
  });
}

describe('M-M1 — webhook health is the caller\'s own', () => {
  it('shows an agent their deliveries and not a colleague\'s', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      const aForm = `form-a-${tag()}`;
      const bForm = `form-b-${tag()}`;
      const aPage = await connectForm(tx, a, aForm);
      const bPage = await connectForm(tx, b, bForm);
      await delivery(tx, aForm, aPage);
      await delivery(tx, bForm, bPage);
      await delivery(tx, bForm, bPage);

      const mine = await syncFor(tx).webhookHealth(asUser(a));
      const events = mine.events as { form_id: string }[];

      expect(mine.total).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0].form_id).toBe(aForm);
      // The colleague's leadgen ids must not appear anywhere in the response.
      expect(JSON.stringify(mine)).not.toContain(bForm);
    });
  });

  it('shows an agent with no forms nothing at all, rather than everything', async () => {
    await inRollback(async (tx) => {
      const stranger = await makeUser(tx);
      const other = await makeUser(tx);
      const formId = `form-${tag()}`;
      const pageId = await connectForm(tx, other, formId);
      await delivery(tx, formId, pageId);

      const health = await syncFor(tx).webhookHealth(asUser(stranger));
      expect(health.total).toBe(0);
      expect(health.events).toHaveLength(0);
    });
  });

  it('keeps history for a form the agent has since disconnected', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx);
      const formId = `form-${tag()}`;
      const pageId = await connectForm(tx, a, formId);
      await delivery(tx, formId, pageId);
      await tx.meta_lead_forms.updateMany({ where: { user_id: a, form_id: formId }, data: { is_active: false } });

      // Losing the trail the moment a form is switched off would hide the period being diagnosed.
      const health = await syncFor(tx).webhookHealth(asUser(a));
      expect(health.total).toBe(1);
      expect(health.connected_forms).toBe(0);
    });
  });

  it('lets a Super Admin see across the brokerage, which is the only view an unroutable delivery appears in', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx);
      const admin = await makeUser(tx, 'admin');
      const formId = `form-${tag()}`;
      const pageId = await connectForm(tx, a, formId);
      await delivery(tx, formId, pageId);

      const health = await syncFor(tx).webhookHealth(asUser(admin, 'admin'));
      expect((health.total as number)).toBeGreaterThanOrEqual(1);
    });
  });

  it('reports connected-but-silent, which is what a stopped webhook looks like', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx);
      const formId = `form-${tag()}`;
      const pageId = await connectForm(tx, a, formId);

      // Connected, never any delivery.
      const never = await syncFor(tx).webhookHealth(asUser(a));
      expect(never.stalled).toBe(true);
      expect(never.stalled_reason).toContain('no webhook delivery has ever been received');

      // A recent delivery clears it.
      await delivery(tx, formId, pageId);
      const healthy = await syncFor(tx).webhookHealth(asUser(a));
      expect(healthy.stalled).toBe(false);
      expect(healthy.stalled_reason).toBeNull();
    });
  });

  it('does not cry stalled when no forms are connected at all', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx);
      const health = await syncFor(tx).webhookHealth(asUser(a));
      expect(health.connected_forms).toBe(0);
      expect(health.stalled).toBe(false);
    });
  });
});

describe('M-M2 — a redeemed OAuth nonce stays redeemed', () => {
  it('is enforced by the unique index, not by memory', async () => {
    await inRollback(async (tx) => {
      process.env.APP_KEY = 'state-signing-key';
      const state = new MetaStateService(tx);
      const issued = state.issue(42);

      expect(await state.verify(issued)).toBe(42);
      expect(await state.verify(issued)).toBeNull();

      // A brand-new instance — the equivalent of a restart, or a second app server — must reach
      // the same verdict. The old in-memory Set started empty in both cases.
      const afterRestart = new MetaStateService(tx);
      expect(await afterRestart.verify(issued)).toBeNull();
    });
  });

  it('sweeps expired nonces without forgetting live ones', async () => {
    await inRollback(async (tx) => {
      process.env.APP_KEY = 'state-signing-key';
      const state = new MetaStateService(tx);

      await tx.meta_oauth_nonces.create({
        data: { nonce: `stale-${tag()}`, expires_at: new Date(Date.now() - 60_000) },
      });
      const live = state.issue(9);
      expect(await state.verify(live)).toBe(9);   // this redeem also runs the sweep

      const remaining = await tx.meta_oauth_nonces.findMany({ select: { nonce: true } });
      expect(remaining.some((r) => r.nonce.startsWith('stale-'))).toBe(false);
      expect(remaining).toHaveLength(1);
      // And the live one is still rejected on replay.
      expect(await state.verify(live)).toBeNull();
    });
  });
});

describe('M-M4 — the stored Graph payload is bounded and forgotten', () => {
  const lead = (chars: number) => ({
    id: `lg-${tag()}`,
    created_time: new Date().toISOString(),
    field_data: [{ name: 'message', values: ['x'.repeat(chars)] }],
  });

  it('stores a normal payload verbatim', () => {
    const raw = (syncFor(null as never) as unknown as { rawForStorage: (l: unknown) => string })
      .rawForStorage(lead(50));
    expect(JSON.parse(raw)._truncated).toBeUndefined();
  });

  it('caps a runaway payload and says so, rather than clipping it into plausible JSON', () => {
    const raw = (syncFor(null as never) as unknown as { rawForStorage: (l: unknown) => string })
      .rawForStorage(lead(META_RAW_MAX_CHARS * 3));
    const parsed = JSON.parse(raw);
    expect(parsed._truncated).toBe(true);
    expect(parsed._original_length).toBeGreaterThan(META_RAW_MAX_CHARS);
    expect(parsed._payload.length).toBe(META_RAW_MAX_CHARS);
  });

  it('clears payloads past the retention window and leaves recent ones alone', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const old = new Date(Date.now() - (META_RAW_RETENTION_DAYS + 1) * 86_400_000);
      const stale = await tx.leads.create({
        data: {
          name: `Old ${tag()}`, email: `old-${tag()}@example.test`,
          meta_raw: '{"answers":"old"}', meta_imported_at: old, created_at: old, updated_at: old,
        },
      });
      const fresh = await tx.leads.create({
        data: {
          name: `New ${tag()}`, email: `new-${tag()}@example.test`,
          meta_raw: '{"answers":"new"}', meta_imported_at: now, created_at: now, updated_at: now,
        },
      });

      const cleared = await syncFor(tx).pruneRawPayloads();
      expect(cleared).toBeGreaterThanOrEqual(1);

      // The payload goes; the lead itself does not.
      const after = await tx.leads.findUnique({ where: { id: stale.id } });
      expect(after?.meta_raw).toBeNull();
      expect(after?.name).toBe(stale.name);
      expect((await tx.leads.findUnique({ where: { id: fresh.id } }))?.meta_raw).toBe('{"answers":"new"}');
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
