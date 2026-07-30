import type { Area } from '../common/domain';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

/** Lifecycle of a todo. "cancelled" keeps a dropped item visible instead of deleting it. */
export const TODO_STATUSES = ['pending', 'completed', 'cancelled'] as const;
export const TODO_PRIORITIES = ['low', 'medium', 'high'] as const;

const isStatus = (v: string): boolean => (TODO_STATUSES as readonly string[]).includes(v);
const isPriority = (v: string): boolean => (TODO_PRIORITIES as readonly string[]).includes(v);

const str = (v: unknown): string => String(v ?? '').trim();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface TodoInput {
  title?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  due_date?: unknown;
}

export interface TodoQuery {
  search?: string;
  status?: string;
  priority?: string;
}

@Injectable()
export class TodosService {
  constructor(private readonly prisma: PrismaService) {}

  /** A todo is a personal reminder, so everyone sees only their own — including admins. */
  private scope(user: AuthUserRecord): Prisma.todosWhereInput {
    return { user_id: user.id ?? -1 };
  }

  /**
   * Which list an area's To-Do panel shows.
   *
   * A CRM task must not appear in the Transaction Management list and vice versa. Tasks with no
   * area pre-date the split; they appear in both rather than being guessed at, because an
   * unassigned task hidden from the half of the application its owner works in is a task that gets
   * missed. Section 11's "shared task" is exactly this state.
   */
  private areaWhere(area: Area): Prisma.todosWhereInput {
    return { OR: [{ domain: area }, { domain: null }] };
  }

  async list(user: AuthUserRecord, area: Area, q: TodoQuery = {}): Promise<Record<string, unknown>> {
    const and: Prisma.todosWhereInput[] = [{ deleted_at: null }, this.scope(user), this.areaWhere(area)];

    const search = str(q.search);
    if (search) {
      const like = { contains: search, mode: 'insensitive' as const };
      and.push({ OR: [{ title: like }, { description: like }] });
    }
    const status = str(q.status);
    if (status && isStatus(status)) and.push({ status });
    const priority = str(q.priority);
    if (priority && isPriority(priority)) and.push({ priority });

    const where: Prisma.todosWhereInput = { AND: and };

    const rows = await this.prisma.todos.findMany({
      where,
      // Undated items sort last, then soonest due date, then newest.
      orderBy: [{ due_date: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }],
    });

    // Counts ignore the search and dropdown filters so the tallies describe the whole list,
    // not whatever is on screen — otherwise "Pending (0)" would appear while filtering.
    // Area-scoped as well, or the CRM's "3 pending" would be counting Transaction Desk tasks that
    // its own list never shows — a tally that cannot be worked down.
    const base: Prisma.todosWhereInput = { AND: [{ deleted_at: null }, this.scope(user), this.areaWhere(area)] };
    const [pending, completed, cancelled, overdue] = await Promise.all([
      this.prisma.todos.count({ where: { AND: [base, { status: 'pending' }] } }),
      this.prisma.todos.count({ where: { AND: [base, { status: 'completed' }] } }),
      this.prisma.todos.count({ where: { AND: [base, { status: 'cancelled' }] } }),
      this.prisma.todos.count({
        where: { AND: [base, { status: 'pending' }, { due_date: { lt: this.startOfToday() } }] },
      }),
    ]);

    return {
      data: rows.map((r) => this.present(r)),
      counts: { total: pending + completed + cancelled, pending, completed, cancelled, overdue },
    };
  }

  async create(input: TodoInput, user: AuthUserRecord, area: Area): Promise<Record<string, unknown>> {
    const data = this.validate(input, true);
    const now = new Date();
    const row = await this.prisma.todos.create({
      data: {
        ...data,
        title: data.title as string,
        user_id: user.id ?? null,
        // Belongs to the area it was added in, so it stays on that list.
        domain: area,
        created_by: user.name,
        created_at: now,
        updated_at: now,
      },
    });
    return this.present(row);
  }

  async update(id: number, input: TodoInput, user: AuthUserRecord, area: Area): Promise<Record<string, unknown>> {
    const existing = await this.prisma.todos.findFirst({ where: { id, deleted_at: null, AND: [this.scope(user), this.areaWhere(area)] } });
    if (!existing) throw new NotFoundException({ message: 'Todo not found.' });

    const data = this.validate(input, false);
    // Stamp (or clear) the completion time whenever the status moves in or out of "completed",
    // so the timestamp can never disagree with the status.
    if (typeof data.status === 'string' && data.status !== existing.status) {
      data.completed_at = data.status === 'completed' ? new Date() : null;
    }

    const row = await this.prisma.todos.update({ where: { id }, data: { ...data, updated_at: new Date() } });
    return this.present(row);
  }

  /** Soft delete, so a checklist item removed by mistake is still recoverable in the database. */
  async remove(id: number, user: AuthUserRecord, area: Area): Promise<{ deleted: boolean }> {
    const existing = await this.prisma.todos.findFirst({ where: { id, deleted_at: null, AND: [this.scope(user), this.areaWhere(area)] } });
    if (!existing) throw new NotFoundException({ message: 'Todo not found.' });
    await this.prisma.todos.update({ where: { id }, data: { deleted_at: new Date(), updated_at: new Date() } });
    return { deleted: true };
  }

  // ------------------------------------------------------------ validation
  private validate(input: TodoInput, requireCore: boolean): Record<string, unknown> {
    const errors: Record<string, string[]> = {};
    const add = (f: string, m: string) => { (errors[f] ??= []).push(m); };
    const out: Record<string, unknown> = {};
    const has = (k: keyof TodoInput) => input[k] !== undefined;

    if (requireCore || has('title')) {
      const title = str(input.title);
      if (!title) add('title', 'A title is required.');
      else if (title.length > 255) add('title', 'The title must be 255 characters or fewer.');
      else out.title = title;
    }

    if (has('description')) {
      const d = str(input.description);
      if (d.length > 5000) add('description', 'Must be 5,000 characters or fewer.');
      else out.description = d === '' ? null : d;
    }

    if (has('status')) {
      const s = str(input.status);
      if (!isStatus(s)) add('status', `The status must be one of: ${TODO_STATUSES.join(', ')}.`);
      else out.status = s;
    }

    if (requireCore || has('priority')) {
      const p = str(input.priority) || 'medium';
      if (!isPriority(p)) add('priority', `The priority must be one of: ${TODO_PRIORITIES.join(', ')}.`);
      else out.priority = p;
    }

    if (has('due_date')) {
      const v = str(input.due_date).slice(0, 10);
      if (v === '') out.due_date = null;
      else if (!DATE_RE.test(v)) add('due_date', 'The due date must be in YYYY-MM-DD format.');
      else {
        const d = new Date(`${v}T00:00:00.000Z`);
        // `new Date('2026-02-30')` rolls over to March 2 instead of returning NaN, so the round
        // trip is compared rather than only checking for NaN.
        if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) add('due_date', 'That date does not exist.');
        else out.due_date = d;
      }
    }

    if (Object.keys(errors).length) {
      const first = Object.values(errors)[0][0];
      const count = Object.values(errors).reduce((a, v) => a + v.length, 0);
      throw new BadRequestException({
        message: count > 1 ? `${first} (and ${count - 1} more error${count - 1 === 1 ? '' : 's'})` : first,
        errors,
      });
    }
    return out;
  }

  /** UTC midnight today — todos are stored as plain dates, so the comparison must be too. */
  private startOfToday(): Date {
    return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  }

  private present(r: Record<string, unknown>): Record<string, unknown> {
    const due = r.due_date instanceof Date ? r.due_date.toISOString().slice(0, 10) : null;
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      priority: r.priority,
      due_date: due,
      // Only a pending item can be overdue — a completed or cancelled one never is.
      overdue: !!due && r.status === 'pending' && new Date(`${due}T00:00:00.000Z`) < this.startOfToday(),
      completed_at: r.completed_at instanceof Date ? r.completed_at.toISOString() : null,
      created_by: r.created_by,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : null,
    };
  }
}
