import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RecruitmentInterviewNotifyService } from './recruitment-interview-notify.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { can } from '../core/authz';
import {
  type CandidateStatus, DECIDER_ONLY, canMove, isCandidateStatus, isInterviewStatus,
  label, refusalFor,
} from './recruitment.status';

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * The filter keys for the two "nobody" rows in Reports. Sentinels rather than empty strings, so
 * "no filter" (absent) and "filter to the missing ones" can never be confused.
 */
export const UNASSIGNED = 'none';
export const SOURCE_NOT_RECORDED = '__none__';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The three the brokerage uses. Mirrored by a CHECK constraint on the column. */
export const AVAILABILITY = ['full_time', 'part_time', 'flexible'] as const;

/**
 * UNDEFINED, NULL AND A VALUE ARE THREE DIFFERENT THINGS on an edit, and collapsing them loses
 * information nobody can recover. `undefined` is "the form did not mention this field", so it is
 * left alone; `null` or an empty string is "clear it"; anything else is the new value. Treating a
 * missing field as a clear would wipe a licence number every time somebody edited a phone number.
 */
function optionalBool(v: unknown): boolean | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return v === true || v === 'true' || v === 1 || v === '1';
}

function optionalText(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  return str(v) || null;
}

/**
 * Recruitment, up to but not including the moment a candidate becomes a user.
 *
 * THE DIVISION THIS SERVICE EXISTS TO HOLD. A recruiter does the work — contacts people, books
 * interviews, writes feedback, collects documents, and RECOMMENDS. An administrator decides. Those
 * are different rights, so they are different checks: `recruitment: 'edit'` opens the screens, and
 * `recruitment.decide` is required separately for the three statuses that amount to accepting
 * somebody. Creating the account itself is further still — see `RecruitmentAgentService`.
 *
 * EVERY READ IS SCOPED, NOT JUST THE LIST. A recruiter sees the candidates assigned to them, which
 * is their whole job; `recruitment.view-all` is what widens that. The scope is applied in
 * `visibleWhere` and used by every path that reaches a candidate, because a detail endpoint that
 * forgot it would hand over by id exactly what the list refuses to show.
 */
@Injectable()
export class RecruitmentService {
  /*
   * `notify` IS OPTIONAL, and deliberately so. Several specs construct this service directly with
   * nothing but a Prisma client — they are testing scope and status rules, not notifications — and
   * a required dependency would have broken every one of them to add a feature none of them
   * exercise. Absent, the service behaves exactly as it did before interviews raised alerts.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify?: RecruitmentInterviewNotifyService,
  ) {}

  /**
   * The candidate, under this person's scope — the same check every endpoint here makes.
   *
   * Public because the SMS service needs it and must not be allowed to invent its own: a texting
   * endpoint that looked a candidate up by id without the scope would hand a recruiter the phone
   * number of somebody they are not allowed to see, which is the one thing `mine` exists to stop.
   */
  async candidateFor(user: AuthUserRecord, id: number) {
    return this.mine(user, id);
  }

  // ------------------------------------------------------------------ scope

  /**
   * Which candidates this person may see.
   *
   * `assigned_recruiter_id` only, for somebody without `recruitment.view-all`. Deliberately NOT
   * "assigned to me OR unassigned": an unassigned candidate belongs to nobody yet, and showing
   * them to every recruiter would make the assignment meaningless.
   */
  private visibleWhere(user: AuthUserRecord): Prisma.recruitment_candidatesWhereInput {
    const base: Prisma.recruitment_candidatesWhereInput = { deleted_at: null };
    if (can(user, 'recruitment.view-all')) return base;
    return { AND: [base, { assigned_recruiter_id: user.id ?? -1 }] };
  }

  /** The candidate, or a refusal that does not reveal whether the id exists. */
  private async mine(user: AuthUserRecord, id: number) {
    const row = await this.prisma.recruitment_candidates.findFirst({
      where: { AND: [{ id }, this.visibleWhere(user)] },
    });
    if (!row) throw new NotFoundException({ message: 'Candidate not found.' });
    return row;
  }

  private assertDecider(user: AuthUserRecord): void {
    if (!can(user, 'recruitment.decide')) {
      throw new ForbiddenException({
        message: 'Only an administrator can approve a candidate or start their onboarding. '
          + 'Record a recommendation instead and an administrator will decide.',
      });
    }
  }

  // ------------------------------------------------------------------ history

  /**
   * Append to the candidate's history. Takes `db` so it joins the caller's transaction when there
   * is one — a history entry that survives a rolled-back change would be a record of something
   * that did not happen.
   */
  async event(
    db: Prisma.TransactionClient | PrismaService,
    candidateId: number,
    action: string,
    detail: string | null,
    user: AuthUserRecord | null,
  ): Promise<void> {
    await db.recruitment_events.create({
      data: {
        candidate_id: candidateId,
        action,
        detail,
        actor_name: user?.name ?? null,
        actor_id: user?.id ?? null,
        created_at: new Date(),
      },
    });
  }

  // ------------------------------------------------------------------ names

  /**
   * Ids turned into names, once, where the ids are.
   *
   * RESOLVED ON THE SERVER RATHER THAN BY THE SCREEN. The alternative is handing the client a user
   * directory so it can look them up, which means every person who may open Recruitment can read a
   * list of everybody in the brokerage — a wider disclosure than the screen itself makes, and one
   * that exists only to render a label. Here, only the names actually referenced leave the server.
   *
   * One query for however many ids, because the obvious shape — a lookup per row — turns a list of
   * forty candidates into forty-one queries.
   */
  private async namesFor(ids: (number | null | undefined)[]): Promise<Map<number, string>> {
    const wanted = [...new Set(ids.filter((v): v is number => typeof v === 'number'))];
    if (wanted.length === 0) return new Map();
    const rows = await this.prisma.users.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /**
   * The people a candidate may be assigned to.
   *
   * ITS OWN ENDPOINT RATHER THAN REUSING `/api/leads/options`, which already returns this exact
   * shape — because that route is gated on `lead: view`, and a recruiter holds `lead: none` by
   * design. Reusing it would mean either widening a recruiter's access to the Leads module or
   * leaving the control unusable for the role that needs it most.
   *
   * Active users only: assigning work to a deactivated account would silently strand a candidate.
   */
  async people(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.users.findMany({
      where: { status: 'Active' },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
    return { data: rows };
  }

  // ------------------------------------------------------------------ reports

  /**
   * The counts behind the dashboard and the Reports tab.
   *
   * SCOPED LIKE EVERYTHING ELSE. A recruiter's totals cover their own candidates, because a count
   * is a disclosure too — "41 candidates" tells somebody the size of a pipeline they cannot open.
   *
   * Interviews are counted by their OWN status, not the candidate's. A candidate on hold may still
   * have a completed interview, and reporting those together would hide exactly the cases somebody
   * is looking for.
   */
  async stats(user: AuthUserRecord): Promise<Record<string, unknown>> {
    const scope = this.visibleWhere(user);

    const [byStatus, bySource, interviews, recruiters, overdue] = await Promise.all([
      this.prisma.recruitment_candidates.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
      this.prisma.recruitment_candidates.groupBy({ by: ['source'], where: scope, _count: { _all: true } }),
      this.prisma.recruitment_interviews.groupBy({ by: ['status'], where: { candidate: scope }, _count: { _all: true } }),
      this.prisma.recruitment_candidates.groupBy({ by: ['assigned_recruiter_id'], where: scope, _count: { _all: true } }),
      this.prisma.recruitment_followups.count({ where: { done_at: null, due_at: { lt: new Date() }, candidate: scope } }),
    ]);

    const count = (rows: { status: string; _count: { _all: number } }[], key: string) =>
      rows.find((r) => r.status === key)?._count._all ?? 0;

    // Names for the recruiter breakdown, in one query rather than one per row.
    const ids = recruiters.map((r) => r.assigned_recruiter_id).filter((v): v is number => v !== null);
    const people = ids.length
      ? await this.prisma.users.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(people.map((p) => [p.id, p.name]));

    return {
      total: byStatus.reduce((n, r) => n + r._count._all, 0),
      candidates: {
        new: count(byStatus, 'new'),
        contacted: count(byStatus, 'contacted'),
        interview: count(byStatus, 'interview'),
        approved: count(byStatus, 'approved'),
        onboarding: count(byStatus, 'onboarding'),
        active: count(byStatus, 'active'),
        hold: count(byStatus, 'hold'),
        not_selected: count(byStatus, 'not_selected'),
      },
      interviews: {
        scheduled: count(interviews, 'scheduled'),
        completed: count(interviews, 'completed'),
        approved: count(interviews, 'approved'),
        hold: count(interviews, 'hold'),
        not_selected: count(interviews, 'not_selected'),
      },
      by_recruiter: recruiters
        .map((r) => ({
          recruiter_id: r.assigned_recruiter_id,
          key: r.assigned_recruiter_id === null ? UNASSIGNED : String(r.assigned_recruiter_id),
          name: r.assigned_recruiter_id ? (nameOf.get(r.assigned_recruiter_id) ?? `User #${r.assigned_recruiter_id}`) : 'Unassigned',
          count: r._count._all,
        }))
        .sort((a, b) => b.count - a.count),
      by_source: this.sourceRows(bySource),
      followups_overdue: overdue,
    };
  }

  // ------------------------------------------------------------------ drill-down filters

  /**
   * The recruiter / source part of a candidate query, as Reports counts it.
   *
   *   recruiter: a user id, or `none` for candidates nobody is assigned to.
   *   source:    a source value exactly as stored, or `__none__` for NOT RECORDED — a null or empty
   *              source, which `stats()` reports together as one "Not recorded" row.
   *
   * Absent means "any". Anything else is refused rather than silently ignored, because an ignored
   * filter shows MORE than the report row that was clicked.
   */
  private drillDown(query: Record<string, unknown>): Prisma.recruitment_candidatesWhereInput[] {
    const out: Prisma.recruitment_candidatesWhereInput[] = [];
    const recruiter = str(query.recruiter);
    if (recruiter) {
      if (recruiter === UNASSIGNED) out.push({ assigned_recruiter_id: null });
      else if (/^\d+$/.test(recruiter)) out.push({ assigned_recruiter_id: Number(recruiter) });
      else throw new BadRequestException({ message: 'Unknown recruiter filter.' });
    }
    if (query.source !== undefined && query.source !== null && String(query.source) !== '') {
      const source = String(query.source);
      out.push(source === SOURCE_NOT_RECORDED ? { OR: [{ source: null }, { source: '' }] } : { source });
    }
    return out;
  }

  // ------------------------------------------------------------------ interviews

  /**
   * Every interview across the candidates this person may see, optionally one status.
   *
   * SCOPED EXACTLY AS `stats()` COUNTS THEM — `candidate: visibleWhere(user)` — so the "Interviews
   * Scheduled" and "Completed Interviews" cards always equal the list they open. Capped at 200 like
   * the candidate list; the total says how many there are.
   */
  async interviews(user: AuthUserRecord, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const status = str(query.status);
    if (status && !isInterviewStatus(status)) {
      throw new BadRequestException({ message: 'Unknown interview status.' });
    }
    const where: Prisma.recruitment_interviewsWhereInput = {
      candidate: this.visibleWhere(user),
      ...(status ? { status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.recruitment_interviews.findMany({
        where,
        // Soonest first while they are still ahead; a finished one has no "soonest".
        orderBy: status === 'scheduled' ? [{ scheduled_at: 'asc' }, { id: 'asc' }] : [{ scheduled_at: 'desc' }, { id: 'desc' }],
        take: 200,
        include: { candidate: { select: { id: true, name: true, status: true } } },
      }),
      this.prisma.recruitment_interviews.count({ where }),
    ]);
    const names = await this.namesFor(rows.map((r) => r.interviewer_id));
    return {
      total,
      data: rows.map((r) => ({
        id: r.id,
        status: r.status,
        scheduled_at: r.scheduled_at?.toISOString() ?? null,
        mode: r.mode,
        location: r.location,
        interviewer_name: r.interviewer_id ? names.get(r.interviewer_id) ?? null : null,
        candidate: r.candidate,
      })),
    };
  }

  /**
   * Candidate counts by source, keyed for drill-down. Null and empty are both NOT RECORDED — one row,
   * matching the `__none__` filter. Any other value is its own row and filters by that exact value.
   */
  private sourceRows(rows: { source: string | null; _count: { _all: number } }[]): { source: string; key: string; count: number }[] {
    const merged = new Map<string, { source: string; key: string; count: number }>();
    for (const r of rows) {
      const missing = r.source === null || r.source === '';
      const key = missing ? SOURCE_NOT_RECORDED : (r.source as string);
      const row = merged.get(key) ?? { source: missing ? 'Not recorded' : (r.source as string), key, count: 0 };
      row.count += r._count._all;
      merged.set(key, row);
    }
    return [...merged.values()].sort((a, b) => b.count - a.count);
  }

  // ------------------------------------------------------------------ candidates

  async list(user: AuthUserRecord, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const status = str(query.status);
    const search = str(query.q);
    const where: Prisma.recruitment_candidatesWhereInput = {
      AND: [
        this.visibleWhere(user),
        ...(isCandidateStatus(status) ? [{ status }] : []),
        // Recruiter and source on the SERVER, by the same rule Reports counts with, so the list a
        // report row opens holds exactly that row's number — not a slice of the first 200 rows.
        ...this.drillDown(query),
        ...(search
          ? [{
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
              { phone: { contains: search, mode: 'insensitive' as const } },
            ],
          }]
          : []),
      ],
    };

    /*
     * PAGED, so every candidate a filter matches can be reached — "Referral 347" shows all 347, 50 at a
     * time, rather than the first 200. `id` ends the ordering, so two candidates added in the same
     * second still have a fixed place and no row appears on two pages or on none. A page past the end
     * answers the last page rather than an empty list.
     */
    const perPage = Math.min(200, Math.max(1, Number(query.per_page) || 50));
    const total = await this.prisma.recruitment_candidates.count({ where });
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(lastPage, Math.max(1, Math.floor(Number(query.page)) || 1));

    const rows = await this.prisma.recruitment_candidates.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * perPage,
      take: perPage,
    });
    const names = await this.namesFor(rows.map((r) => r.assigned_recruiter_id));
    return {
      data: rows.map((r) => ({
        ...r,
        // Null when unassigned, so the screen can say "Unassigned" rather than inventing a name.
        assigned_recruiter_name: r.assigned_recruiter_id ? (names.get(r.assigned_recruiter_id) ?? null) : null,
      })),
      total,
      page,
      per_page: perPage,
      last_page: lastPage,
    };
  }

  async show(user: AuthUserRecord, id: number): Promise<Record<string, unknown>> {
    const candidate = await this.mine(user, id);
    const [interviews, notes, followups, documents, onboarding, events] = await Promise.all([
      this.prisma.recruitment_interviews.findMany({ where: { candidate_id: id }, orderBy: [{ scheduled_at: 'desc' }, { id: 'desc' }] }),
      this.prisma.recruitment_notes.findMany({ where: { candidate_id: id }, orderBy: { id: 'desc' } }),
      this.prisma.recruitment_followups.findMany({ where: { candidate_id: id }, orderBy: [{ done_at: 'asc' }, { due_at: 'asc' }] }),
      this.prisma.recruitment_documents.findMany({ where: { candidate_id: id }, orderBy: { id: 'asc' } }),
      this.prisma.recruitment_onboarding_items.findMany({ where: { candidate_id: id }, orderBy: [{ position: 'asc' }, { id: 'asc' }] }),
      this.prisma.recruitment_events.findMany({ where: { candidate_id: id }, orderBy: { id: 'desc' }, take: 200 }),
    ]);
    /*
     * Every id this screen shows a label for, resolved together. `actor_name` on an event is
     * already a name — captured when it happened, so it still reads correctly after somebody is
     * renamed or leaves — and is deliberately not re-resolved here.
     */
    const names = await this.namesFor([
      candidate.assigned_recruiter_id,
      candidate.recommended_by_user_id,
      candidate.approved_by_user_id,
      candidate.referred_by_user_id,
      candidate.agent_user_id,
      ...interviews.map((i) => i.interviewer_id),
      ...followups.map((f) => f.assigned_to),
    ]);
    const nameOf = (id: number | null) => (id ? (names.get(id) ?? null) : null);

    return {
      candidate: {
        ...candidate,
        assigned_recruiter_name: nameOf(candidate.assigned_recruiter_id),
        recommended_by_name: nameOf(candidate.recommended_by_user_id),
        approved_by_name: nameOf(candidate.approved_by_user_id),
        referred_by_name: nameOf(candidate.referred_by_user_id),
        agent_user_name: nameOf(candidate.agent_user_id),
      },
      interviews: interviews.map((i) => ({ ...i, interviewer_name: nameOf(i.interviewer_id) })),
      notes,
      followups: followups.map((f) => ({ ...f, assigned_to_name: nameOf(f.assigned_to) })),
      documents,
      onboarding,
      events,
    };
  }

  /**
   * The experience and licence fields, validated once for both create and edit.
   *
   * Years is checked here AND by a CHECK constraint: the constraint is right whatever route the
   * value arrives by, and this is what turns "violates check constraint" into a sentence.
   */
  private experienceFrom(body: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    const hasExp = optionalBool(body.has_real_estate_experience);
    if (hasExp !== undefined) out.has_real_estate_experience = hasExp;

    if (body.years_experience !== undefined) {
      const raw = body.years_experience;
      if (raw === null || raw === '') {
        out.years_experience = null;
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new BadRequestException({ message: 'Years of experience must be a whole number, and cannot be negative.' });
        }
        if (n > 80) throw new BadRequestException({ message: 'Years of experience looks wrong — check the figure.' });
        out.years_experience = n;
      }
    }

    const licensed = optionalBool(body.is_licensed);
    if (licensed !== undefined) out.is_licensed = licensed;

    const licence = optionalText(body.licence_number);
    if (licence !== undefined) out.licence_number = licence;

    const brokerage = optionalText(body.brokerage_name);
    if (brokerage !== undefined) out.brokerage_name = brokerage;

    if (body.availability !== undefined) {
      const a = str(body.availability);
      if (a && !(AVAILABILITY as readonly string[]).includes(a)) {
        throw new BadRequestException({ message: 'Availability is Full time, Part time or Flexible.' });
      }
      out.availability = a || null;
    }

    const training = optionalText(body.training_needs);
    if (training !== undefined) out.training_needs = training;

    return out;
  }

  async create(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = str(body.name);
    const email = str(body.email).toLowerCase();
    if (!name) throw new BadRequestException({ message: 'A candidate needs a name.' });
    if (!EMAIL_SHAPE.test(email)) throw new BadRequestException({ message: 'A valid email address is required.' });

    /*
     * A WARNING, NOT A REFUSAL, when somebody with this address already exists.
     *
     * A person may legitimately be recorded twice — they applied last year, or a colleague entered
     * them this morning — and refusing would leave the second recruiter unable to record a real
     * conversation. The clash that MUST be refused is creating the account, and that is checked
     * where the account is created rather than guessed at here.
     */
    const existing = await this.prisma.recruitment_candidates.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, deleted_at: null },
      select: { id: true, name: true },
    });

    const now = new Date();
    const row = await this.prisma.recruitment_candidates.create({
      data: {
        name,
        email,
        phone: str(body.phone) || null,
        location: str(body.location) || null,
        source: str(body.source) || null,
        referred_by_user_id: Number(body.referred_by_user_id) || null,
        // A recruiter creating a candidate takes it on; an administrator may assign explicitly.
        assigned_recruiter_id: Number(body.assigned_recruiter_id)
          || (can(user, 'recruitment.view-all') ? null : user.id ?? null),
        status: 'new',
        ...this.experienceFrom(body),
        created_by: user.name ?? null,
        created_at: now,
        updated_at: now,
      },
    });
    await this.event(this.prisma, row.id, 'created', `Added as a candidate${row.source ? ` from ${row.source}` : ''}.`, user);
    return { data: row, duplicate_of: existing ?? null };
  }

  async update(user: AuthUserRecord, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const before = await this.mine(user, id);
    const data: Prisma.recruitment_candidatesUpdateInput = { updated_at: new Date() };
    if (body.name !== undefined) data.name = str(body.name) || before.name;
    if (body.phone !== undefined) data.phone = str(body.phone) || null;
    if (body.location !== undefined) data.location = str(body.location) || null;
    if (body.source !== undefined) data.source = str(body.source) || null;
    if (body.email !== undefined) {
      const email = str(body.email).toLowerCase();
      if (!EMAIL_SHAPE.test(email)) throw new BadRequestException({ message: 'A valid email address is required.' });
      data.email = email;
    }

    Object.assign(data, this.experienceFrom(body));

    const row = await this.prisma.recruitment_candidates.update({ where: { id }, data });
    await this.event(this.prisma, id, 'updated', 'Details edited.', user);
    return { data: row };
  }

  /**
   * Assign or reassign the recruiter.
   *
   * `recruitment.view-all` only — a recruiter handing a candidate to somebody else, or helping
   * themselves to one, is a decision about who does the work rather than part of doing it.
   */
  async assign(user: AuthUserRecord, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!can(user, 'recruitment.view-all')) {
      throw new ForbiddenException({ message: 'Only an administrator can assign a recruiter.' });
    }
    await this.mine(user, id);
    const recruiterId = Number(body.recruiter_id) || null;
    if (recruiterId) {
      const exists = await this.prisma.users.findFirst({ where: { id: recruiterId, status: 'Active' }, select: { id: true, name: true } });
      if (!exists) throw new BadRequestException({ message: 'That person is not an active user.' });
    }
    const before = await this.mine(user, id);
    const previous = before.assigned_recruiter_id;
    const row = await this.prisma.recruitment_candidates.update({
      where: { id }, data: { assigned_recruiter_id: recruiterId, updated_at: new Date() },
    });

    /*
     * NAMES IN THE HISTORY, NOT IDS, and the names as they are NOW — because the history is read
     * long after the fact, by somebody asking who was working this candidate in March. "user #41"
     * answers nothing without a second lookup they may not be able to make.
     */
    const names = await this.namesFor([previous, recruiterId]);
    const to = recruiterId ? (names.get(recruiterId) ?? `user #${recruiterId}`) : null;
    const from = previous ? (names.get(previous) ?? `user #${previous}`) : null;
    const detail = to
      ? (from ? `Reassigned from ${from} to ${to}.` : `Assigned to ${to}.`)
      : (from ? `Unassigned from ${from}.` : 'Recruiter cleared.');

    await this.event(this.prisma, id, 'assigned', detail, user);
    return { data: row };
  }

  /**
   * Move the candidate along.
   *
   * Two separate gates, and the order matters: the MOVE is checked before the RIGHT, so somebody
   * without `recruitment.decide` attempting an impossible jump is told it is impossible rather than
   * that they lack permission — a message that would send them to ask for a right that would not
   * have helped.
   */
  async setStatus(user: AuthUserRecord, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const candidate = await this.mine(user, id);
    const to = str(body.status);
    if (!isCandidateStatus(to)) throw new BadRequestException({ message: 'That is not a candidate status.' });

    const from = candidate.status as CandidateStatus;
    if (from === to) return { data: candidate };
    if (!canMove(from, to)) throw new BadRequestException({ message: refusalFor(from, to) });
    if (DECIDER_ONLY.includes(to)) this.assertDecider(user);

    /*
     * `active` is never reached by moving a status. It means an account exists, and the only thing
     * that may say so is the code that created one — otherwise the record could claim somebody can
     * sign in when nothing was ever created.
     */
    if (to === 'active') {
      throw new BadRequestException({
        message: 'A candidate becomes Active by having their agent account created, not by a status change.',
      });
    }

    const now = new Date();
    const data: Prisma.recruitment_candidatesUpdateInput = { status: to, updated_at: now };
    if (to === 'approved') { data.approved_by_user_id = user.id ?? null; data.approved_at = now; }

    const row = await this.prisma.recruitment_candidates.update({ where: { id }, data });
    await this.event(this.prisma, id, to === 'approved' ? 'approved' : 'status', `${label(from)} → ${label(to)}.`, user);
    return { data: row };
  }

  /** Archive. The row and its history stay; it simply leaves the working list. */
  async archive(user: AuthUserRecord, id: number): Promise<{ message: string }> {
    if (!can(user, 'recruitment.view-all')) {
      throw new ForbiddenException({ message: 'Only an administrator can archive a candidate.' });
    }
    const candidate = await this.mine(user, id);
    if (candidate.agent_user_id) {
      throw new BadRequestException({
        message: 'This candidate has an agent account, so the record is kept as that account’s history.',
      });
    }
    await this.prisma.recruitment_candidates.update({ where: { id }, data: { deleted_at: new Date() } });
    await this.event(this.prisma, id, 'archived', 'Archived.', user);
    return { message: 'Candidate archived.' };
  }

  // ------------------------------------------------------------------ interviews

  async scheduleInterview(user: AuthUserRecord, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const candidate = await this.mine(user, id);
    const when = str(body.scheduled_at);
    const at = when ? new Date(when) : null;
    if (!at || Number.isNaN(at.getTime())) throw new BadRequestException({ message: 'An interview needs a date and time.' });

    const now = new Date();
    const row = await this.prisma.recruitment_interviews.create({
      data: {
        candidate_id: id,
        interviewer_id: Number(body.interviewer_id) || null,
        scheduled_at: at,
        status: 'scheduled',
        mode: str(body.mode) || null,
        location: str(body.location) || null,
        created_by: user.name ?? null,
        created_at: now,
        updated_at: now,
      },
    });

    /*
     * Booking an interview moves a candidate who has not been interviewed yet, because that is what
     * the booking MEANS — and only from the statuses where it is a step forward. A candidate on
     * hold stays on hold until somebody says otherwise.
     */
    if (canMove(candidate.status as CandidateStatus, 'interview')) {
      await this.prisma.recruitment_candidates.update({ where: { id }, data: { status: 'interview', updated_at: now } });
    }
    await this.event(this.prisma, id, 'interview_scheduled', `Interview booked for ${at.toISOString().slice(0, 16).replace('T', ' ')}.`, user);
    // After the write, so nobody is told about an interview that failed to save.
    await this.notify?.changed(candidate, row, 'booked', user);
    return { data: row };
  }

  async updateInterview(user: AuthUserRecord, id: number, interviewId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.mine(user, id);
    const interview = await this.prisma.recruitment_interviews.findFirst({ where: { id: interviewId, candidate_id: id } });
    if (!interview) throw new NotFoundException({ message: 'Interview not found.' });

    const data: Prisma.recruitment_interviewsUpdateInput = { updated_at: new Date() };
    let what = 'Interview updated.';

    if (body.scheduled_at !== undefined) {
      const at = new Date(str(body.scheduled_at));
      if (Number.isNaN(at.getTime())) throw new BadRequestException({ message: 'That is not a valid date and time.' });
      data.scheduled_at = at;
      what = `Interview moved to ${at.toISOString().slice(0, 16).replace('T', ' ')}.`;
    }
    if (body.interviewer_id !== undefined) data.interviewer_id = Number(body.interviewer_id) || null;
    if (body.feedback !== undefined) { data.feedback = str(body.feedback) || null; what = 'Interview feedback recorded.'; }
    if (body.mode !== undefined) data.mode = str(body.mode) || null;
    if (body.location !== undefined) data.location = str(body.location) || null;

    if (body.status !== undefined) {
      const s = str(body.status);
      if (!isInterviewStatus(s)) throw new BadRequestException({ message: 'That is not an interview status.' });
      /*
       * THE INTERVIEW'S OUTCOME IS NOT THE CANDIDATE'S STATUS, and this is the line where the two
       * would most easily be confused. Marking an interview `approved` records what the interviewer
       * concluded; it leaves the candidate exactly where they were. Only `recruitment.decide`, via
       * setStatus, moves the person.
       */
      data.status = s;
      what = `Interview marked ${label(s)}.`;
    }

    const row = await this.prisma.recruitment_interviews.update({ where: { id: interviewId }, data });
    await this.event(this.prisma, id, 'interview_completed', what, user);

    /*
     * WHICH CHANGE WORTH TELLING PEOPLE ABOUT, decided from what actually changed rather than from
     * what the request mentioned. A request may set feedback and a time at once, and recording
     * feedback is not news to the person who wrote it.
     *
     * `cancelled` wins over a time change: an interview that is both moved and called off has been
     * called off. Marking an outcome — completed, approved, hold, not selected — raises nothing,
     * because the people who would hear about it are the ones who were there.
     */
    const cancelled = data.status === 'cancelled' && interview.status !== 'cancelled';
    const moved = data.scheduled_at !== undefined
      && interview.scheduled_at?.getTime() !== (data.scheduled_at as Date | undefined)?.getTime();
    if (cancelled || moved) {
      const candidate = await this.prisma.recruitment_candidates.findUnique({
        where: { id },
        select: { id: true, name: true, assigned_recruiter_id: true },
      });
      if (candidate) {
        /*
         * A cancellation names the time it WAS at, not the new one — "the interview that was set
         * for Tuesday is off" is what the reader needs; the row's current time is of no use to
         * somebody deciding whether to clear their afternoon.
         */
        const subject = cancelled ? { ...row, scheduled_at: interview.scheduled_at } : row;
        await this.notify?.changed(candidate, subject, cancelled ? 'cancelled' : 'moved', user);
      }
    }
    return { data: row };
  }

  /**
   * The recruiter's recommendation — advice, recorded as advice.
   *
   * Writes `recommendation` and who gave it, and does NOT touch `status`. That separation is the
   * reason this endpoint exists rather than letting a recruiter set the status directly.
   */
  async recommend(user: AuthUserRecord, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.mine(user, id);
    const value = str(body.recommendation);
    if (!['approved', 'hold', 'not_selected'].includes(value)) {
      throw new BadRequestException({ message: 'A recommendation is Approved, Hold or Not Selected.' });
    }
    const now = new Date();
    const row = await this.prisma.recruitment_candidates.update({
      where: { id },
      data: { recommendation: value, recommended_by_user_id: user.id ?? null, recommended_at: now, updated_at: now },
    });
    await this.event(this.prisma, id, 'recommended', `Recommended: ${label(value as CandidateStatus)}. Awaiting an administrator's decision.`, user);
    return { data: row };
  }

  // ------------------------------------------------------------------ notes, follow-ups, documents

  async addNote(user: AuthUserRecord, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.mine(user, id);
    const text = str(body.body);
    if (!text) throw new BadRequestException({ message: 'A note needs something in it.' });
    const row = await this.prisma.recruitment_notes.create({
      data: { candidate_id: id, body: text, author: user.name ?? null, user_id: user.id ?? null, created_at: new Date() },
    });
    await this.event(this.prisma, id, 'note', 'Note added.', user);
    return { data: row };
  }

  async addFollowup(user: AuthUserRecord, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.mine(user, id);
    const title = str(body.title);
    const due = new Date(str(body.due_at));
    if (!title) throw new BadRequestException({ message: 'A follow-up needs a title.' });
    if (Number.isNaN(due.getTime())) throw new BadRequestException({ message: 'A follow-up needs a due date.' });
    const now = new Date();
    const row = await this.prisma.recruitment_followups.create({
      data: {
        candidate_id: id, title, due_at: due,
        assigned_to: Number(body.assigned_to) || user.id || null,
        created_by: user.name ?? null, created_at: now, updated_at: now,
      },
    });
    await this.event(this.prisma, id, 'followup', `Follow-up: ${title}.`, user);
    return { data: row };
  }

  async completeFollowup(user: AuthUserRecord, id: number, followupId: number): Promise<Record<string, unknown>> {
    await this.mine(user, id);
    const row = await this.prisma.recruitment_followups.findFirst({ where: { id: followupId, candidate_id: id } });
    if (!row) throw new NotFoundException({ message: 'Follow-up not found.' });
    const done = await this.prisma.recruitment_followups.update({
      where: { id: followupId }, data: { done_at: new Date(), updated_at: new Date() },
    });
    await this.event(this.prisma, id, 'followup', `Follow-up done: ${row.title}.`, user);
    return { data: done };
  }

  /** Pending and overdue, across every candidate this person may see. */
  async pendingFollowups(user: AuthUserRecord): Promise<Record<string, unknown>> {
    const rows = await this.prisma.recruitment_followups.findMany({
      where: { done_at: null, candidate: this.visibleWhere(user) },
      orderBy: { due_at: 'asc' },
      take: 200,
      include: { candidate: { select: { id: true, name: true, status: true } } },
    });
    const now = new Date();
    return {
      data: rows,
      overdue: rows.filter((r) => r.due_at < now).length,
      pending: rows.length,
    };
  }

  /** A document asked for. No file yet — that is exactly what a request is. */
  async requestDocument(user: AuthUserRecord, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.mine(user, id);
    const name = str(body.name);
    if (!name) throw new BadRequestException({ message: 'Say which document is being asked for.' });
    const now = new Date();
    const row = await this.prisma.recruitment_documents.create({
      data: { candidate_id: id, name, requested_at: now, created_at: now, updated_at: now },
    });
    await this.event(this.prisma, id, 'document', `Requested: ${name}.`, user);
    return { data: row };
  }

  /** Record that a document arrived. */
  async receiveDocument(user: AuthUserRecord, id: number, documentId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.mine(user, id);
    const doc = await this.prisma.recruitment_documents.findFirst({ where: { id: documentId, candidate_id: id } });
    if (!doc) throw new NotFoundException({ message: 'Document not found.' });
    const now = new Date();
    const row = await this.prisma.recruitment_documents.update({
      where: { id: documentId },
      data: {
        file_path: str(body.file_path) || doc.file_path,
        file_name: str(body.file_name) || doc.file_name,
        uploaded_at: now, uploaded_by: user.name ?? null, updated_at: now,
      },
    });
    await this.event(this.prisma, id, 'document', `Received: ${doc.name}.`, user);
    return { data: row };
  }

  // ------------------------------------------------------------------ onboarding

  async addOnboardingItem(user: AuthUserRecord, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertDecider(user);
    await this.mine(user, id);
    const title = str(body.title);
    if (!title) throw new BadRequestException({ message: 'An onboarding step needs a title.' });
    const now = new Date();
    const row = await this.prisma.recruitment_onboarding_items.create({
      data: { candidate_id: id, title, position: Number(body.position) || 0, created_at: now, updated_at: now },
    });
    await this.event(this.prisma, id, 'onboarding_started', `Onboarding step: ${title}.`, user);
    return { data: row };
  }

  async completeOnboardingItem(user: AuthUserRecord, id: number, itemId: number): Promise<Record<string, unknown>> {
    await this.mine(user, id);
    const item = await this.prisma.recruitment_onboarding_items.findFirst({ where: { id: itemId, candidate_id: id } });
    if (!item) throw new NotFoundException({ message: 'Onboarding step not found.' });
    const now = new Date();
    const row = await this.prisma.recruitment_onboarding_items.update({
      where: { id: itemId }, data: { done_at: now, done_by: user.name ?? null, updated_at: now },
    });
    await this.event(this.prisma, id, 'onboarding_started', `Onboarding step done: ${item.title}.`, user);
    return { data: row };
  }
}
