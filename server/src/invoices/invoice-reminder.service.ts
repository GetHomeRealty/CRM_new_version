import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicesService } from './invoices.service';
import { parseJson, toDateString } from '../common/serialize';
import { holidaysForYear, DEFAULT_PROVINCE, type Province, isProvince } from '../calendar/holidays';

/**
 * The Invoice auto-reminder — the behaviour `invoices.auto_reminder` was always for.
 *
 * The column has been written by the Invoice editor since it shipped and read by nothing, so an
 * office user could set "every 3 days until paid", see it saved, and no reminder would ever be sent.
 * This is the missing half. It is deliberately NOT a general trigger engine: it evaluates one stored
 * setting on one table and sends one existing template.
 *
 * THE RULE COMES FROM THE SCREEN THAT WRITES IT. `InvoiceEditorModal` offers exactly three shapes and
 * labels the first "Every N days (until Paid, excl. weekends/holidays)":
 *
 *   { mode: '2' | '3' | '5' }              every N BUSINESS days, from the due date, until paid
 *   { mode: 'custom', dates: [...] }        on each listed date, once each
 *   { mode: 'off' } | null                  nothing
 *
 * Nothing here was invented: the cadence, the "until Paid" stop and the weekend/holiday exclusion are
 * all what the option already promises. Business days use the application's own Canadian statutory
 * holiday calendar (`calendar/holidays.ts`) rather than a second list.
 *
 * IDEMPOTENCE COMES FROM THE REMINDER HISTORY, not from a flag. Each send appends to
 * `invoices.reminders`, which is the same list the Invoice screen shows and the same list a manual
 * reminder writes to. A reminder already recorded for a date means that date is done — so a second
 * scheduler pass in the same day, a restart mid-sweep, or two processes racing cannot double-send.
 * There is no separate "last reminded" column to fall out of step with what the user can see.
 *
 * FAILURE DOES NOT RECORD. `InvoicesService.recordReminder` sends first and writes afterwards, so a
 * refused send leaves no history entry — which means the invoice stays eligible and the next pass
 * tries again. That is the retry, and it is the safe direction: a lost reminder is a nuisance, a
 * history entry for a message nobody received is a lie the office acts on.
 */

/** Interval modes the editor offers. Anything else is either `custom` or off. */
const INTERVAL_MODES = new Set(['2', '3', '5']);

/**
 * How far back a missed schedule is honoured.
 *
 * If the scheduler has been down for a month, sending the twelve reminders that were due in the
 * meantime is worse than sending one. A due date older than this window still produces exactly one
 * reminder — today's — rather than a backlog.
 */
const CATCH_UP_DAYS = 30;

/** The shape stored in `invoices.auto_reminder`. */
interface AutoReminder {
  mode?: string;
  dates?: string[];
}

/** One entry in `invoices.reminders`, as `recordReminder` writes it. */
interface ReminderEntry {
  date?: string;
  by?: string | null;
  to?: string | null;
}

export interface ReminderSweepResult {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Why each skipped invoice was skipped, for the log line. */
  reasons: Record<string, number>;
}

@Injectable()
export class InvoiceReminderService {
  private readonly log = new Logger(InvoiceReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
  ) {}

  /** The province whose statutory holidays count as non-business days. Env: INVOICE_REMINDER_PROVINCE */
  private province(): Province {
    const raw = (process.env.INVOICE_REMINDER_PROVINCE ?? '').trim().toUpperCase();
    return isProvince(raw) ? raw : DEFAULT_PROVINCE;
  }

  /**
   * One pass.
   *
   * THE CANDIDATE QUERY IS THE NARROWING, not a scan-and-filter. Everything expressible as a column
   * predicate is a column predicate — not deleted, not Paid or Void, a balance outstanding, a due
   * date that has arrived, and an `auto_reminder` that is not obviously off. Only the JSON shape and
   * the business-day arithmetic happen in Node, over the handful of rows that survive. A brokerage
   * with 22,857 invoices has a few dozen candidates on any given day, not 22,857.
   */
  async sweep(now: Date = new Date()): Promise<ReminderSweepResult> {
    const today = toDateString(now)!;
    const result: ReminderSweepResult = { considered: 0, sent: 0, skipped: 0, failed: 0, reasons: {} };
    const skip = (why: string): void => { result.skipped += 1; result.reasons[why] = (result.reasons[why] ?? 0) + 1; };

    const candidates = await this.prisma.invoices.findMany({
      where: {
        deleted_at: null,
        auto_reminder: { not: null },
        // "Until Paid". `Void` is not a debt and `Draft` has not been issued, so neither is chased.
        status: { notIn: ['Paid', 'Void', 'Draft'] },
        balance_due: { gt: 0 },
      },
      select: {
        id: true, invoice_no: true, auto_reminder: true, reminders: true,
        due_date: true, status: true, balance_due: true, customer_email: true, transaction_id: true,
      },
      orderBy: { id: 'asc' },
    });

    for (const inv of candidates) {
      result.considered += 1;
      const auto = parseJson<AutoReminder>(inv.auto_reminder) ?? {};
      const mode = String(auto.mode ?? '').trim();

      if (mode === '' || mode === 'off') { skip('disabled'); continue; }

      const history = this.historyDates(inv.reminders);
      if (history.has(today)) { skip('already sent today'); continue; }

      const due = this.dueOn(mode, auto, inv.due_date, history, today);
      if (!due) { skip(mode === 'custom' ? 'no custom date today' : 'not due yet'); continue; }

      try {
        // Straight through the module's own send path: it resolves the recipient (falling back to
        // the co-operating brokerage's invoice address), sends via the Transaction Desk mail
        // account, and only then appends the history entry and the audit row.
        // `now` rather than the wall clock inside the invoice service: the day this pass EVALUATED
        // must be the day it records, or a sweep spanning midnight sends twice. See recordReminder.
        await this.invoices.recordReminder(null, inv.id, null, now);
        result.sent += 1;
      } catch (err) {
        result.failed += 1;
        // Left eligible on purpose — nothing was recorded, so the next pass tries again.
        this.log.warn(`Auto-reminder for invoice ${inv.invoice_no} failed: ${(err as Error)?.message ?? String(err)}`);
      }
    }

    const parts = Object.entries(result.reasons).map(([k, v]) => `${k}=${v}`).join(' ');
    this.log.log(`Invoice auto-reminders: ${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped of ${result.considered} candidates${parts ? ` (${parts})` : ''}.`);
    return result;
  }

  /** The dates a reminder has already gone out on, from the invoice's own history. */
  private historyDates(raw: string | null): Set<string> {
    const rows = parseJson<ReminderEntry[]>(raw);
    const out = new Set<string>();
    if (!Array.isArray(rows)) return out;
    for (const r of rows) {
      // `recordReminder` writes "YYYY-MM-DD HH:mm:ss"; the day is the part that matters here.
      const d = typeof r?.date === 'string' ? r.date.slice(0, 10) : '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.add(d);
    }
    return out;
  }

  /** Is a reminder due today for this invoice? */
  private dueOn(mode: string, auto: AutoReminder, dueDate: Date | null, history: Set<string>, today: string): boolean {
    if (mode === 'custom') {
      const dates = Array.isArray(auto.dates) ? auto.dates.map(String) : [];
      // Exactly the dates somebody picked, each once — no business-day adjustment, because a chosen
      // date is a chosen date.
      return dates.includes(today) && !history.has(today);
    }

    if (!INTERVAL_MODES.has(mode)) return false;
    const step = Number(mode);

    // Nothing to count from and nothing overdue: an invoice with no due date is not yet chased.
    const start = toDateString(dueDate);
    if (!start || start > today) return false;

    // Weekends and statutory holidays are not reminder days, which is what the option promises.
    if (!this.isBusinessDay(today)) return false;

    /*
     * COUNTED FROM THE LAST REMINDER, falling back to the due date.
     *
     * Counting from the due date alone would put the whole schedule out of step the first time a
     * send failed or the scheduler was down — and counting from "the last send" is also what "every
     * N days" means to the person who chose it.
     */
    const last = [...history].filter((d) => d <= today).sort().pop() ?? null;
    const anchor = last ?? start;
    if (anchor === today) return false;

    const elapsed = this.businessDaysBetween(anchor, today);
    if (elapsed < step) return false;

    /*
     * A LONG OUTAGE PRODUCES ONE REMINDER, NOT A BACKLOG. `sweep` sends at most one per invoice per
     * pass anyway; this bound is about the OTHER direction — an invoice whose due date passed months
     * ago and which has never been reminded is chased from today rather than treated as owing a
     * dozen missed sends.
     */
    if (!last && this.businessDaysBetween(start, today) > CATCH_UP_DAYS) {
      this.log.log(`Invoice due ${start} is long overdue; sending one reminder rather than the missed schedule.`);
    }
    return true;
  }

  /** Monday to Friday, excluding this province's statutory holidays. */
  isBusinessDay(date: string): boolean {
    const d = new Date(`${date}T00:00:00.000Z`);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) return false;
    return !this.statutory(d.getUTCFullYear()).has(date);
  }

  /** Statutory holiday dates for one year, cached per year — the calendar module's own list. */
  private readonly holidayCache = new Map<string, Set<string>>();
  private statutory(year: number): Set<string> {
    const key = `${this.province()}:${year}`;
    const held = this.holidayCache.get(key);
    if (held) return held;
    const set = new Set(
      holidaysForYear(year, this.province())
        .filter((h) => h.kind === 'statutory')
        .map((h) => h.date),
    );
    this.holidayCache.set(key, set);
    return set;
  }

  /** Business days strictly after `from`, up to and including `to`. */
  businessDaysBetween(from: string, to: string): number {
    if (from >= to) return 0;
    let count = 0;
    const cursor = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    // Bounded so a corrupt date cannot spin: a decade of days is far past any real schedule.
    for (let guard = 0; guard < 4000 && cursor < end; guard += 1) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (this.isBusinessDay(cursor.toISOString().slice(0, 10))) count += 1;
    }
    return count;
  }
}
