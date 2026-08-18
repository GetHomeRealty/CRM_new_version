import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { InvoiceReminderService } from './invoice-reminder.service';
import { InvoicesService } from './invoices.service';
import { InvoiceReminderScheduler } from './invoice-reminder.scheduler';
import { can } from '../core/authz';

/**
 * THE INVOICE AUTO-REMINDER.
 *
 * `invoices.auto_reminder` has been written by the Invoice editor since it shipped and read by
 * nothing: an office user could set "every 3 days until paid", watch it save, and no reminder would
 * ever go out. These tests cover the half that was missing, and they are organised around the ways
 * an automatic mail sender goes wrong rather than around its methods.
 *
 *   IT SENDS WHEN IT SHOULD NOT — a paid, void, deleted or disabled invoice chased anyway. Every one
 *   of those is a customer receiving a demand for money they do not owe.
 *
 *   IT SENDS TWICE — a second pass in the same day, a restart, or two processes. Two identical
 *   chasers read as a second demand.
 *
 *   IT RECORDS A SEND THAT DID NOT HAPPEN — the failure mode the manual invoice send already had
 *   fixed, where `sent_at` and an audit row were written for a message that never left.
 *
 * The mailer is replaced by a stub so the send can be made to fail on demand; everything else —
 * eligibility, the history, the recipient, the audit row — is the real code against the real
 * database.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

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

/** A mailer that records what it was asked to send, and can be told to refuse. */
class StubMailer {
  sent: { event: string; to: string }[] = [];
  fail = false;
  async send(event: string, _vars: unknown, to: string | string[]): Promise<void> {
    if (this.fail) throw new Error('550 mailbox unavailable');
    this.sent.push({ event, to: Array.isArray(to) ? to.join(',') : to });
  }
}

/** An audit sink — the reminder path writes one entry per send. */
class StubAudit {
  entries: unknown[] = [];
  async logModule(_actor: unknown, _module: string, entry: unknown): Promise<void> { this.entries.push(entry); }
  async record(_txnId: number, _actor: unknown, entry: unknown): Promise<void> { this.entries.push(entry); }
}

function build(tx: PrismaService, mailer: StubMailer, audit = new StubAudit()) {
  const settings = { current: async () => ({ name: 'Test Brokerage', default_tax_rate: 13 }) };
  const calc = { recalculate: async () => undefined };
  const invoices = new InvoicesService(
    tx,
    settings as never,
    calc as never,
    null as never,
    audit as never,
    null as never,
    mailer as never,
  );
  return { invoices, reminders: new InvoiceReminderService(tx, invoices), audit };
}

/**
 * A FIXED "now" — a Wednesday — rather than the real clock.
 *
 * The interval modes deliberately skip weekends and statutory holidays, so a suite run on a Saturday
 * would see every interval reminder correctly skipped and every assertion about sending fail. That
 * is the feature working, not a bug, and a test that only passes Monday to Friday is not a test.
 *
 * `sweep(now)` takes the moment to evaluate, and it is threaded through to the history entry, so the
 * date the sweep reasons about and the date it records are the same one.
 */
const NOW = new Date('2026-08-19T10:00:00.000Z'); // a Wednesday, and not a statutory holiday

const day = (offsetDays: number): Date => {
  const d = new Date(NOW);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
};
const iso = (d: Date): string => d.toISOString().slice(0, 10);

interface InvoiceSpec {
  auto?: unknown;
  status?: string;
  balance?: number;
  dueOffset?: number | null;
  deleted?: boolean;
  reminders?: { date: string }[];
  email?: string | null;
}

async function makeInvoice(tx: PrismaService, o: InvoiceSpec = {}): Promise<number> {
  const now = new Date();
  const inv = await tx.invoices.create({
    data: {
      invoice_no: `AR-${Date.now()}-${++seq}`,
      status: o.status ?? 'Unpaid',
      customer_name: 'Chased Customer',
      customer_email: o.email === undefined ? 'chased@spec.test' : o.email,
      invoice_date: day(-30),
      due_date: o.dueOffset === null ? null : day(o.dueOffset ?? -10),
      terms: 'Net 30',
      sub_total: 1000, tax_total: 130, total: 1130,
      amount_paid: 0, balance_due: o.balance ?? 1130,
      auto_reminder: o.auto === undefined ? JSON.stringify({ mode: '2' }) : (o.auto === null ? null : JSON.stringify(o.auto)),
      reminders: JSON.stringify(o.reminders ?? []),
      deleted_at: o.deleted ? now : null,
      created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  return inv.id;
}

/** How many reminder entries the invoice's own history holds. */
async function historyCount(tx: PrismaService, id: number): Promise<number> {
  const row = await tx.invoices.findUniqueOrThrow({ where: { id }, select: { reminders: true } });
  const list = JSON.parse(row.reminders || '[]') as unknown[];
  return Array.isArray(list) ? list.length : 0;
}

describe('an auto-reminder is sent when the invoice is eligible', () => {
  it('auto-reminder ON, overdue, unpaid — one reminder goes out and is recorded', async () => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      const { reminders } = build(tx, mailer);
      const id = await makeInvoice(tx, { auto: { mode: '2' }, dueOffset: -20 });

      const out = await reminders.sweep(NOW);
      expect(out.sent).toBeGreaterThanOrEqual(1);
      expect(mailer.sent.some((m) => m.event === 'invoice.reminder')).toBe(true);
      expect(await historyCount(tx, id)).toBe(1);
    });
  });

  it('records an audit entry naming the reminder', async () => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      const { reminders, audit } = build(tx, mailer);
      await makeInvoice(tx, { auto: { mode: '2' }, dueOffset: -20 });
      await reminders.sweep(NOW);
      expect(JSON.stringify(audit.entries)).toMatch(/Reminder sent/i);
    });
  });

  it('resolves the recipient, and skips an invoice with nobody to write to', async () => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      const { reminders } = build(tx, mailer);
      const withEmail = await makeInvoice(tx, { auto: { mode: '2' }, dueOffset: -20, email: 'billing@spec.test' });
      const withNone = await makeInvoice(tx, { auto: { mode: '2' }, dueOffset: -20, email: null });

      const out = await reminders.sweep(NOW);
      expect(mailer.sent.map((m) => m.to)).toContain('billing@spec.test');
      // No recipient is a FAILURE, not a silent success: nothing is recorded for it.
      expect(out.failed).toBeGreaterThanOrEqual(1);
      expect(await historyCount(tx, withNone)).toBe(0);
      expect(await historyCount(tx, withEmail)).toBe(1);
    });
  });
});

describe('an auto-reminder is NOT sent when it should not be', () => {
  const cases: [string, InvoiceSpec][] = [
    ['auto-reminder OFF', { auto: { mode: 'off' } }],
    ['auto-reminder never configured', { auto: null }],
    ['a fully PAID invoice', { status: 'Paid', balance: 0 }],
    ['a VOID invoice', { status: 'Void' }],
    ['a DRAFT that was never issued', { status: 'Draft' }],
    ['a DELETED invoice', { deleted: true }],
    ['an invoice with no balance outstanding', { balance: 0 }],
    ['an invoice not yet due', { dueOffset: 30 }],
    ['an invoice with no due date at all', { dueOffset: null }],
  ];

  it.each(cases)('%s', async (_label, spec) => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      const { reminders } = build(tx, mailer);
      const id = await makeInvoice(tx, { auto: { mode: '2' }, ...spec });

      await reminders.sweep(NOW);
      expect(await historyCount(tx, id)).toBe(0);
    });
  });

  it('a PARTIALLY paid invoice IS still chased — there is a balance owing', async () => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      const { reminders } = build(tx, mailer);
      const id = await makeInvoice(tx, { auto: { mode: '2' }, status: 'Partially Paid', balance: 500, dueOffset: -20 });
      await reminders.sweep(NOW);
      expect(await historyCount(tx, id)).toBe(1);
    });
  });
});

describe('it does not send twice', () => {
  it('a SECOND SWEEP the same day sends nothing more', async () => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      const { reminders } = build(tx, mailer);
      const id = await makeInvoice(tx, { auto: { mode: '2' }, dueOffset: -20 });

      await reminders.sweep(NOW);
      const first = mailer.sent.length;
      await reminders.sweep(NOW);

      expect(mailer.sent.length).toBe(first);
      expect(await historyCount(tx, id)).toBe(1);
    });
  });

  it('an invoice already reminded today is skipped, whatever the interval says', async () => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      const { reminders } = build(tx, mailer);
      const id = await makeInvoice(tx, {
        auto: { mode: '2' }, dueOffset: -60,
        reminders: [{ date: `${iso(day(0))} 09:00:00` }],
      });

      await reminders.sweep(NOW);
      expect(mailer.sent).toHaveLength(0);
      expect(await historyCount(tx, id)).toBe(1);
    });
  });

  it('the interval is respected — a reminder sent yesterday does not repeat today on "every 5 days"', async () => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      const { reminders } = build(tx, mailer);
      await makeInvoice(tx, {
        auto: { mode: '5' }, dueOffset: -60,
        reminders: [{ date: `${iso(day(-1))} 09:00:00` }],
      });
      await reminders.sweep(NOW);
      expect(mailer.sent).toHaveLength(0);
    });
  });

  it('the scheduler does not start a second pass while one is running', async () => {
    let running = 0;
    let overlapped = false;
    const slow = {
      sweep: async () => {
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 30));
        running -= 1;
        return { considered: 0, sent: 0, skipped: 0, failed: 0, reasons: {} };
      },
    };
    const scheduler = new InvoiceReminderScheduler(slow as never);
    await Promise.all([scheduler.run(), scheduler.run(), scheduler.run()]);
    expect(overlapped).toBe(false);
  });
});

describe('custom dates', () => {
  it('sends on a listed date', async () => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      const { reminders } = build(tx, mailer);
      const id = await makeInvoice(tx, { auto: { mode: 'custom', dates: [iso(day(0))] }, dueOffset: -5 });
      await reminders.sweep(NOW);
      expect(await historyCount(tx, id)).toBe(1);
    });
  });

  it('sends nothing on a date that is not listed', async () => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      const { reminders } = build(tx, mailer);
      const id = await makeInvoice(tx, { auto: { mode: 'custom', dates: [iso(day(7))] }, dueOffset: -5 });
      await reminders.sweep(NOW);
      expect(await historyCount(tx, id)).toBe(0);
    });
  });

  it('a custom mode with no dates at all sends nothing', async () => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      const { reminders } = build(tx, mailer);
      const id = await makeInvoice(tx, { auto: { mode: 'custom' }, dueOffset: -5 });
      await reminders.sweep(NOW);
      expect(await historyCount(tx, id)).toBe(0);
    });
  });
});

describe('a failed send is not recorded as a reminder', () => {
  it('nothing is written to the history, and the invoice stays eligible', async () => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      mailer.fail = true;
      const { reminders } = build(tx, mailer);
      const id = await makeInvoice(tx, { auto: { mode: '2' }, dueOffset: -20 });

      const out = await reminders.sweep(NOW);
      expect(out.failed).toBe(1);
      expect(out.sent).toBe(0);
      expect(await historyCount(tx, id)).toBe(0);

      // The retry: the very next pass tries again, because nothing marked it done.
      mailer.fail = false;
      const second = await reminders.sweep(NOW);
      expect(second.sent).toBe(1);
      expect(await historyCount(tx, id)).toBe(1);
    });
  });

  it('one failing invoice does not stop the others in the same pass', async () => {
    await inRollback(async (tx) => {
      const mailer = new StubMailer();
      const { reminders } = build(tx, mailer);
      const noRecipient = await makeInvoice(tx, { auto: { mode: '2' }, dueOffset: -20, email: null });
      const fine = await makeInvoice(tx, { auto: { mode: '2' }, dueOffset: -20 });

      const out = await reminders.sweep(NOW);
      expect(out.failed).toBeGreaterThanOrEqual(1);
      expect(await historyCount(tx, noRecipient)).toBe(0);
      expect(await historyCount(tx, fine)).toBe(1);
    });
  });
});

describe('weekends and statutory holidays are not reminder days', () => {
  const svc = new InvoiceReminderService(null as never, null as never);

  it('a Saturday and a Sunday are not business days', () => {
    // 2026-08-15 is a Saturday, 2026-08-16 a Sunday.
    expect(svc.isBusinessDay('2026-08-15')).toBe(false);
    expect(svc.isBusinessDay('2026-08-16')).toBe(false);
    expect(svc.isBusinessDay('2026-08-17')).toBe(true);
  });

  it('Canada Day is not a business day', () => {
    expect(svc.isBusinessDay('2026-07-01')).toBe(false);
  });

  it('business days are counted excluding the weekend between them', () => {
    // Friday to the following Monday is ONE business day, not three.
    expect(svc.businessDaysBetween('2026-08-14', '2026-08-17')).toBe(1);
    // Monday to Friday of the same week is four.
    expect(svc.businessDaysBetween('2026-08-17', '2026-08-21')).toBe(4);
  });
});

describe('the Invoice roles are unchanged by this work', () => {
  it('only admin, manager and accounting hold invoice access', () => {
    const holds = (role: string) => can({ role } as never, 'invoices.access');
    expect(holds('admin')).toBe(true);
    expect(holds('manager')).toBe(true);
    expect(holds('accounting')).toBe(true);
    // The three that must NOT gain access through the reminder work.
    expect(holds('agent')).toBe(false);
    expect(holds('documentation')).toBe(false);
    expect(holds('crm')).toBe(false);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
