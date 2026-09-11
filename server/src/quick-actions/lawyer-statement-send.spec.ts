import { PrismaClient } from '@prisma/client';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { QuickSendService } from './quick-send.service';

/**
 * Sending the Commission / Lawyer Statement from its dialog.
 *
 * The statement is built in the browser and arrives as a PDF; the API's half is who may send it,
 * for which deals, and that the PDF goes with it to the address given and nobody else. Real rows in
 * a rolled-back transaction, with a mailer that records instead of sending.
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
    }, { timeout: 20000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

type Sent = { event: unknown; vars: Record<string, unknown>; to: unknown; cc: unknown; attachments: { name?: string; mime?: string }[] };

function services(tx: PrismaService) {
  const sent: Sent[] = [];
  const quick = new QuickSendService(
    tx,
    { record: async () => undefined, log: async () => undefined } as never,
    { send: async (event: unknown, vars: Record<string, unknown>, to: unknown, cc: unknown, attachments: Sent['attachments']) => { sent.push({ event, vars, to, cc, attachments }); } } as never,
    { current: async () => ({ name: 'Test Brokerage' }) } as never,
    new ResourceAccessService(tx),
  );
  return { quick, sent };
}

const ADMIN = { id: 990000, name: 'An Admin', role: 'admin' } as never;
const AGENT = { id: 990001, name: 'An Agent', role: 'agent' } as never;
const PDF = Buffer.from('%PDF-1.4 statement').toString('base64');

async function deal(tx: PrismaService, type: string) {
  const now = new Date();
  const n = ++seq;
  return tx.transactions.create({
    data: {
      agent: null, trade_no: `LS-${Date.now()}-${n}`, type, property: `${n} Statement St`,
      lawyer_name: 'Jane Counsel', created_at: now, updated_at: now,
    },
  });
}

const attempt = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try { await fn(); return null; } catch (e) { return e; }
};

describe('sending the Lawyer Statement', () => {
  it('mails a listing deal\'s statement, PDF attached, to the address given and nobody else', async () => {
    await inRollback(async (tx) => {
      const d = await deal(tx, 'Residential Sale Listing');
      const { quick, sent } = services(tx);

      const res = await quick.lawyerStatement(ADMIN, d.id, { email: 'lawyer@example.test', pdf: PDF, filename: 'Commission Statement - X.pdf' });
      expect(res).toMatchObject({ ok: true });
      expect(sent).toHaveLength(1);
      expect(sent[0].event).toBe('lawyer_statement.send');
      expect(sent[0].to).toBe('lawyer@example.test');
      expect(sent[0].cc).toEqual([]);
      expect(sent[0].attachments).toEqual([{ data: PDF, name: 'Commission Statement - X.pdf', mime: 'application/pdf' }]);
      expect(sent[0].vars.lawyer_name).toBe('Jane Counsel');
    });
  });

  it('sends for a Business Sale too — the other type the button appears on', async () => {
    await inRollback(async (tx) => {
      const d = await deal(tx, 'Business Sale');
      const { quick, sent } = services(tx);
      await quick.lawyerStatement(ADMIN, d.id, { email: 'lawyer@example.test', pdf: PDF });
      expect(sent).toHaveLength(1);
    });
  });

  it('refuses a deal that is not a listing, and mails nothing', async () => {
    await inRollback(async (tx) => {
      const d = await deal(tx, 'Residential Buying');
      const { quick, sent } = services(tx);
      expect(await attempt(() => quick.lawyerStatement(ADMIN, d.id, { email: 'lawyer@example.test', pdf: PDF })))
        .toBeInstanceOf(UnprocessableEntityException);
      expect(sent).toHaveLength(0);
    });
  });

  it('refuses an agent — the button is hidden from them, and so is the route', async () => {
    await inRollback(async (tx) => {
      const d = await deal(tx, 'Residential Sale Listing');
      const { quick, sent } = services(tx);
      expect(await attempt(() => quick.lawyerStatement(AGENT, d.id, { email: 'lawyer@example.test', pdf: PDF })))
        .toBeInstanceOf(ForbiddenException);
      expect(sent).toHaveLength(0);
    });
  });

  it('refuses a send with no statement attached, and mails nothing', async () => {
    await inRollback(async (tx) => {
      const d = await deal(tx, 'Residential Sale Listing');
      const { quick, sent } = services(tx);
      const err = await attempt(() => quick.lawyerStatement(ADMIN, d.id, { email: 'lawyer@example.test' }));
      expect(err).toBeTruthy();
      expect(JSON.stringify((err as { response?: unknown }).response)).toContain('statement PDF is required');
      expect(sent).toHaveLength(0);
    });
  });
});
