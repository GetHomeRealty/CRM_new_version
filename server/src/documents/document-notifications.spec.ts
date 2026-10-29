import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { DocumentsService } from './documents.service';
import { DocumentMailService } from './document-mail.service';
import { DocumentDigestService } from './document-digest.service';
import { MAIL_EVENTS, renderTemplate } from '../email/mail-event-registry';

/**
 * DOCUMENT NOTIFICATIONS BETWEEN AGENTS AND DOCUMENTATION (Sai, 29 Oct 2026).
 *
 *   Agent submits documents      -> Documentation (the deal's "Handled by", else the team for the
 *                                   deal's country): bell + phone, ONE message per submit, re-uploads
 *                                   after Invalid marked. No email ("only bell and phone").
 *   Office marks Valid / Invalid -> every agent on the deal (co-agents too): the review email, the bell
 *                                   (DocReview audit row) and the phone, with the other changes.
 *   Office adds a remark, changes a status or asks for a new document (no Valid/Invalid)
 *                                -> every agent on the deal: bell + phone, ONE message per save.
 *   Every morning from 8         -> each Documentation person: one email + bell, "X documents waiting".
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

type Dispatched = { category: string; userId: number; title: string; body?: string; channels?: string[]; dedupeKey?: string };
const harness = (tx: PrismaService) => {
  const sent: { event: string; vars: Record<string, string>; to: unknown }[] = [];
  const dispatched: Dispatched[] = [];
  const ledger = new Set<string>();
  const mailer = { send: async (event: string, vars: Record<string, string>, to: unknown) => { sent.push({ event, vars, to }); } };
  const settings = { current: async () => ({ name: 'Test Brokerage' }) };
  const dispatcher = {
    dispatch: async (r: Dispatched) => {
      dispatched.push(r);
      const k = `${r.userId}|${r.category}|${r.dedupeKey}`;
      if (r.dedupeKey && ledger.has(k)) return { delivered: [], skipped: [{ channel: 'in_app', reason: 'duplicate' }], failed: [] };
      if (r.dedupeKey) ledger.add(k);
      return { delivered: r.channels ?? [], skipped: [], failed: [] };
    },
    shouldSend: async () => true,
  };
  const mail = new DocumentMailService(tx, mailer as never, settings as never, dispatcher as never);
  // The service opens its own transaction for agent submissions; inside this rolled-back one it runs on the same connection.
  const db = new Proxy(tx as object, { get: (t, k) => (k === '$transaction' ? (fn: (x: unknown) => unknown) => fn(t) : (t as never)[k]) }) as PrismaService;
  const svc = new DocumentsService({} as never, db, { record: async () => undefined } as never, { sync: async () => undefined } as never, {} as never, {} as never, mail);
  let n = 0;
  jest.spyOn(svc as never, 'storeFile' as never).mockImplementation((async () => `docnotify/${++n}.pdf`) as never);
  jest.spyOn(svc as never, 'deleteFile' as never).mockResolvedValue(undefined as never);
  // deals@ keeps its email with the file; not what is tested here.
  jest.spyOn(mail, 'notifyUpload').mockResolvedValue(undefined);
  const digest = new DocumentDigestService(tx, mailer as never, settings as never, dispatcher as never, {} as never, {} as never);
  return { svc, mail, digest, sent, dispatched };
};

async function user(tx: PrismaService, role: string, over: Record<string, unknown> = {}) {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const now = new Date();
  return tx.users.create({
    data: { name: `DN ${role} ${tag}`, email: `dn-${role}-${tag}@example.test`, role, status: 'Active', password: 'x', created_at: now, updated_at: now, ...over },
    select: { id: true, name: true, email: true },
  });
}

async function deal(tx: PrismaService, agent: { id: number; name: string }, over: Record<string, unknown> = {}) {
  const now = new Date();
  return tx.transactions.create({ data: {
    trade_no: `DN-${Date.now()}-${++seq}`, type: 'Residential Buying', property: '5 Notice Lane',
    agent: agent.name, agent_user_id: agent.id, price: 500000,
    comm_type: '%', comm_value: 0, comm_pct: 2.5, comm_status: 'Pending', comm_paid_status: 'No',
    closing_date: new Date('2026-12-15T00:00:00.000Z'), offer_date: new Date('2026-09-01T00:00:00.000Z'),
    adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now, ...over,
  } });
}

const doc = (tx: PrismaService, txnId: number, over: Record<string, unknown> = {}) => tx.documents.create({ data: {
  transaction_id: txnId, title: 'APS', mandatory: false, manual: true,
  status: 'Pending', validation: 'Pending', position: 1, created_at: new Date(), updated_at: new Date(), ...over,
} as never });

const row = (d: { id: number; title: string; mandatory: boolean; status: string; validation: string; remarks?: string | null }, over: Record<string, unknown> = {}) =>
  ({ id: d.id, title: d.title, mandatory: d.mandatory, status: d.status, validation: d.validation, remarks: d.remarks ?? null, ...over });
const asUser = (u: { id: number; name: string }, role: string) => ({ ...u, role, user_permissions: [], user_modules: [] }) as never;
const pdf = { originalname: 'aps.pdf', buffer: Buffer.from('%PDF-1.4 dn'), size: 11, mimetype: 'application/pdf' };

async function submit(h: ReturnType<typeof harness>, tx: PrismaService, agent: { id: number; name: string }, txnId: number, docIds: number[]) {
  for (const id of docIds) await h.svc.uploadFile(asUser(agent, 'agent'), txnId, id, pdf as never);
  const drafts = await tx.documents.findMany({ where: { id: { in: docIds } }, select: { draft_files: true } });
  const ids = drafts.flatMap((d) => (JSON.parse(d.draft_files ?? '[]') as { id: string }[]).map((f) => f.id));
  await h.svc.submitDrafts(asUser(agent, 'agent'), txnId, { draft_ids: ids });
}

describe('agent uploads -> Documentation (bell + phone, no email)', () => {
  jest.setTimeout(60_000);

  it('the deal\'s Handled by person only, one message for the whole submit, re-upload marked', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx, 'agent');
      const handler = await user(tx, 'documentation');
      const other = await user(tx, 'documentation');
      const t = await deal(tx, agent, { doc_handler_id: handler.id });
      const a = await doc(tx, t.id, { title: 'APS' });
      const b = await doc(tx, t.id, { title: 'Schedule B', validation: 'Invalid', position: 2 });
      const h = harness(tx);
      await submit(h, tx, agent, t.id, [a.id, b.id]);

      const toDocs = h.dispatched.filter((d) => d.category === 'document_uploads');
      expect(toDocs.map((d) => d.userId)).toEqual([handler.id]);
      expect(toDocs.some((d) => d.userId === other.id)).toBe(false);
      expect(toDocs[0].channels).toEqual(['in_app', 'push']);
      expect(toDocs[0].title).toContain('uploaded 2 documents (1 re-uploaded)');
      expect(toDocs[0].body).toBe('APS · Schedule B (re-upload after Invalid)');
      expect(h.sent).toHaveLength(0); // no email to Documentation
    });
  });

  it('nobody handling the deal: everyone active in Documentation for its country', async () => {
    await inRollback(async (tx) => {
      await tx.users.updateMany({ where: { role: 'documentation' }, data: { status: 'Inactive' } });
      const agent = await user(tx, 'agent');
      const ca = await user(tx, 'documentation');
      const both = await user(tx, 'documentation', { markets: 'CA,IN' });
      await user(tx, 'documentation', { markets: 'IN' });
      const t = await deal(tx, agent);
      const a = await doc(tx, t.id);
      const h = harness(tx);
      await submit(h, tx, agent, t.id, [a.id]);
      expect(h.dispatched.filter((d) => d.category === 'document_uploads').map((d) => d.userId).sort()).toEqual([ca.id, both.id].sort());
    });
  });
});

describe('the office acts on documents -> every agent on the deal', () => {
  jest.setTimeout(60_000);

  it('a remark, a status and a new document: ONE bell + phone message to the agent and the co-agent', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx, 'agent');
      const coAgent = await user(tx, 'agent');
      const admin = await user(tx, 'admin');
      const t = await deal(tx, agent);
      await tx.team_members.create({ data: { transaction_id: t.id, name: coAgent.name, user_id: coAgent.id } as never });
      const a = await doc(tx, t.id, { title: 'APS' });
      const b = await doc(tx, t.id, { title: 'Fintrac', position: 2 });
      const h = harness(tx);
      await h.svc.bulkUpdate(asUser(admin, 'admin'), t.id, { documents: [
        row(a, { remarks: 'Page 3 not signed' }),
        row(b, { status: 'Received' }),
        { title: 'Deposit Receipt', mandatory: false, status: 'Pending', validation: 'Pending' },
      ] });
      const msgs = h.dispatched.filter((d) => d.category === 'document_review');
      expect(msgs.map((d) => d.userId).sort()).toEqual([agent.id, coAgent.id].sort());
      expect(msgs[0].channels).toEqual(['in_app', 'push']);
      expect(msgs[0].body).toBe('APS: remark "Page 3 not signed" · Fintrac: Received · New document needed: Deposit Receipt');
      expect(h.sent).toHaveLength(0);
    });
  });

  it('Valid / Invalid: the review email to both agents, and the phone (the bell is the review row)', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx, 'agent');
      const coAgent = await user(tx, 'agent');
      const admin = await user(tx, 'admin');
      const t = await deal(tx, agent);
      await tx.team_members.create({ data: { transaction_id: t.id, name: coAgent.name, user_id: coAgent.id } as never });
      const a = await doc(tx, t.id, { title: 'APS' });
      const h = harness(tx);
      await h.svc.bulkUpdate(asUser(admin, 'admin'), t.id, { documents: [row(a, { validation: 'Invalid', remarks: 'Wrong version' })] });
      expect(h.sent.filter((m) => m.event === 'document.review_result').map((m) => m.to).sort()).toEqual([agent.email, coAgent.email].sort());
      const msgs = h.dispatched.filter((d) => d.category === 'document_review');
      expect(msgs).toHaveLength(2);
      expect(msgs[0].channels).toEqual(['push']);
      expect(msgs[0].body).toContain('APS: remark "Wrong version"');
    });
  });

  it('a save that changes nothing tells nobody', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx, 'agent');
      const admin = await user(tx, 'admin');
      const t = await deal(tx, agent);
      const a = await doc(tx, t.id, { remarks: 'Old note' });
      const h = harness(tx);
      await h.svc.bulkUpdate(asUser(admin, 'admin'), t.id, { documents: [row({ ...a, remarks: 'Old note' })] });
      expect(h.dispatched).toHaveLength(0);
      expect(h.sent).toHaveLength(0);
    });
  });
});

describe('the morning summary to Documentation', () => {
  jest.setTimeout(60_000);

  it('from 8 am, once a day, listing only the deals the person looks after', async () => {
    await inRollback(async (tx) => {
      await tx.users.updateMany({ where: { role: 'documentation' }, data: { status: 'Inactive' } });
      const agent = await user(tx, 'agent');
      const jo = await user(tx, 'documentation');
      const sa = await user(tx, 'documentation');
      const mine = await deal(tx, agent, { doc_handler_id: jo.id });
      const nobodys = await deal(tx, agent);
      await doc(tx, mine.id, { file_path: 'x/1.pdf', status: 'Received', uploaded_at: new Date('2026-10-01T12:00:00Z') });
      await doc(tx, mine.id, { file_path: 'x/2.pdf', status: 'Received', validation: 'Valid', position: 2 }); // reviewed: not waiting
      await doc(tx, mine.id, { position: 3 });                                                               // no file: not waiting
      await doc(tx, nobodys.id, { file_path: 'x/3.pdf', status: 'Received' });
      const h = harness(tx);

      expect(await h.digest.send(new Date(2026, 9, 30, 7, 30))).toEqual([]); // before 8
      const told = await h.digest.send(new Date(2026, 9, 30, 9, 0));
      expect(told.sort()).toEqual([jo.id, sa.id].sort());
      const toJo = h.sent.find((m) => m.to === jo.email)!;
      expect(toJo.vars.document_count).toBe('2');   // her deal + the deal nobody handles
      expect(toJo.vars.deal_count).toBe('2');
      const toSa = h.sent.find((m) => m.to === sa.email)!;
      expect(toSa.vars.document_count).toBe('1');   // only the deal nobody handles

      expect(await h.digest.send(new Date(2026, 9, 30, 10, 0))).toEqual([]); // same day again: nothing
      expect(h.sent.filter((m) => m.event === 'document.waiting_summary')).toHaveLength(2);
    });
  });
});

describe('the morning summary email renders as a table, not as code (the first email Jyothi got, 29 Oct)', () => {
  it('keeps the deals table as HTML but still escapes what is inside it', async () => {
    await inRollback(async (tx) => {
      const h = harness(tx);
      const table = (h.digest as unknown as { table: (d: unknown[]) => string }).table([
        { id: 1, trade_no: '002384', property: '48 <b>Goldenwood</b>', agent: 'A & B', waiting: 1, oldest: null },
      ]);
      const html = renderTemplate(MAIL_EVENTS['document.waiting_summary'].default_body_html, { recipient_name: 'Jyothi', document_count: '1', deal_count: '1', deals_table: table, company_name: 'X' });
      expect(html).toContain('<table style=');
      expect(html).not.toContain('&lt;table');
      expect(html).toContain('48 &lt;b&gt;Goldenwood&lt;/b&gt;');
      expect(html).toContain('A &amp; B');
    });
  });
});
