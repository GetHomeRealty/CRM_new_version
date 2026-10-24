import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { can } from '../core/authz';

/*
 * RECRUITMENT → ONBOARDING & TRAINING — the brokerage's "Onboarding & Trainings" sheet, as a tab.
 *
 * Steps are the sheet's columns (17 onboarding steps, 12 training topics), people its rows, marks its
 * cells. Anyone with `recruitment: edit` — Super Admin, Admin and Recruiter — fills in the cells and
 * adds people; changing the step list, removing a person and importing the sheet are `recruitment.decide`
 * (Super Admin and Admin), because those change the brokerage's list rather than one agent's progress.
 *
 * NOT SCOPED TO ASSIGNED CANDIDATES. Unlike the Candidates tab, every recruiter sees every agent here:
 * most of these agents joined before Recruitment existed and have no recruiter, and the brokerage asked
 * for recruiters to work the whole list. Agents are refused by the controller's guard.
 *
 * A candidate who reaches Onboarding or Active joins the list by itself — see `syncCandidates`.
 */

export const ONBOARDING_KINDS = ['onboarding', 'training'] as const;
export type OnboardingKind = (typeof ONBOARDING_KINDS)[number];

/** The sheet's drop-down values, per kind. Mirrored by the CHECK constraint on the marks table. */
export const ONBOARDING_VALUES: Record<OnboardingKind, readonly string[]> = {
  onboarding: ['yes', 'no', 'in_progress', 'not_attended', 'na', 'own_email'],
  training: ['yes', 'no', 'in_progress', 'not_attended', 'interested'],
};

/** How the sheet writes each value, so the import reads it and the screen shows it the same way. */
export const VALUE_LABELS: Record<string, string> = {
  yes: 'YES', no: 'NO', in_progress: 'IN PROGRESS', not_attended: 'Not Attended', na: 'N/A',
  own_email: 'Agent using own email', interested: 'Interested',
};

export const ONBOARDING_IMPORT_LIMITS = { maxFileBytes: 2 * 1024 * 1024, maxPeople: 1000, title: 255, name: 255 } as const;

/** The candidate statuses that put somebody on the list. */
const SYNC_STATUSES = ['onboarding', 'active'];

const str = (v: unknown): string => String(v ?? '').trim();
/** One line, single spaces — the sheet's names and headings carry newlines and runs of spaces. */
const oneLine = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
/** The comparison key for a name: one line, lower case. */
export const nameKey = (v: unknown): string => oneLine(v).toLowerCase();
/** The comparison key for a step title: letters and digits only, so "Agent’s" and "Agent's" agree. */
export const titleKey = (v: unknown): string => oneLine(v).toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * A name from the sheet, split into the name and its "(FE)" / "(FF)" tag. The sheet also has the typo
 * "(FE0", which is read as FE.
 */
export function splitName(raw: unknown): { name: string; tag: string | null } {
  const line = oneLine(raw);
  const m = line.match(/\(\s*(F[EF])[^)]*\)?\s*$/i);
  if (!m || m.index === undefined) return { name: line, tag: null };
  return { name: line.slice(0, m.index).trim(), tag: m[1].toUpperCase() };
}

/** A cell as written in the sheet → a stored value, '' for blank, or null when it is not one of the sheet's values. */
export function readValue(v: unknown): string | null {
  const s = oneLine(v).toLowerCase();
  if (!s || s === '.') return '';
  for (const [code, label] of Object.entries(VALUE_LABELS)) if (label.toLowerCase() === s) return code;
  return null;
}

type Db = Prisma.TransactionClient | PrismaService;

interface SheetCell { person: string; tag: string | null; step: string; value: string; cell: string }
interface ReadSheets {
  onboardingSheet: string | null;
  trainingSheet: string | null;
  ignoredSheets: string[];
  /** Names in sheet order, as written (tag removed), keyed by `nameKey`. */
  onboardingNames: Map<string, { name: string; tag: string | null }>;
  trainingNames: Map<string, { name: string; tag: string | null }>;
  cells: { onboarding: SheetCell[]; training: SheetCell[] };
  unknownColumns: { sheet: string; title: string }[];
  unknownValues: { sheet: string; cell: string; value: string }[];
}

@Injectable()
export class RecruitmentOnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  private assertManager(user: AuthUserRecord): void {
    if (!can(user, 'recruitment.decide')) {
      throw new ForbiddenException({ message: 'Only an administrator can change the step list, remove an agent or import the sheet.' });
    }
  }

  // ------------------------------------------------------------------------------- the list

  /** Every step (hidden ones flagged), every person on the list with their marks, and the value vocabulary. */
  async list(user: AuthUserRecord): Promise<Record<string, unknown>> {
    await this.syncCandidates();
    const [steps, people] = await Promise.all([
      this.prisma.recruitment_onboarding_steps.findMany({ orderBy: [{ kind: 'asc' }, { position: 'asc' }, { id: 'asc' }] }),
      this.prisma.recruitment_onboarding_people.findMany({
        where: { removed_at: null },
        orderBy: [{ id: 'asc' }],
        include: {
          marks: { select: { step_id: true, value: true } },
          candidate: { select: { id: true, status: true, deleted_at: true } },
        },
      }),
    ]);
    return {
      steps: steps.map((s) => ({ id: s.id, kind: s.kind, title: s.title, position: s.position, hidden: !!s.hidden_at })),
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        tag: p.tag,
        candidate_id: p.candidate && !p.candidate.deleted_at ? p.candidate.id : null,
        candidate_status: p.candidate && !p.candidate.deleted_at ? p.candidate.status : null,
        marks: Object.fromEntries(p.marks.map((m) => [m.step_id, m.value])),
      })),
      values: ONBOARDING_VALUES,
      labels: VALUE_LABELS,
      can_manage: can(user, 'recruitment.decide'),
    };
  }

  /**
   * Put every candidate at Onboarding or Active on the list, once. A person already on the list under
   * the same name and not yet linked to a candidate (an imported agent) is linked rather than doubled.
   * A person an administrator removed stays removed: the link still exists, so they are not re-added.
   */
  async syncCandidates(db: Db = this.prisma): Promise<number> {
    const pending = await db.recruitment_candidates.findMany({
      where: { status: { in: SYNC_STATUSES }, deleted_at: null, onboarding_person: { is: null } },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    let added = 0;
    for (const c of pending) {
      const now = new Date();
      const { name, tag } = splitName(c.name);
      try {
        const twin = await db.recruitment_onboarding_people.findFirst({
          where: { candidate_id: null, removed_at: null, name: { equals: name, mode: 'insensitive' } },
          orderBy: { id: 'asc' },
        });
        if (twin) {
          await db.recruitment_onboarding_people.update({ where: { id: twin.id }, data: { candidate_id: c.id, updated_at: now } });
        } else {
          await db.recruitment_onboarding_people.create({
            data: { name: name.slice(0, ONBOARDING_IMPORT_LIMITS.name), tag, candidate_id: c.id, added_by: 'Recruitment', created_at: now, updated_at: now },
          });
          added += 1;
        }
      } catch (err) {
        // Two screens loading at once: the unique candidate_id lets one win, and the other has nothing to do.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
    }
    return added;
  }

  // ------------------------------------------------------------------------------- cells and people

  /** Set one cell. An empty value clears it. */
  async setMark(user: AuthUserRecord, personId: number, stepId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const [person, step] = await Promise.all([
      this.prisma.recruitment_onboarding_people.findFirst({ where: { id: personId, removed_at: null } }),
      this.prisma.recruitment_onboarding_steps.findUnique({ where: { id: stepId } }),
    ]);
    if (!person) throw new NotFoundException({ message: 'That agent is not on the onboarding list.' });
    if (!step) throw new NotFoundException({ message: 'That step does not exist.' });
    const value = str(body.value);
    if (!value) {
      await this.prisma.recruitment_onboarding_marks.deleteMany({ where: { person_id: personId, step_id: stepId } });
      return { data: { person_id: personId, step_id: stepId, value: null } };
    }
    const allowed = ONBOARDING_VALUES[step.kind as OnboardingKind] ?? [];
    if (!allowed.includes(value)) {
      throw new BadRequestException({ message: `Choose one of: ${allowed.map((v) => VALUE_LABELS[v]).join(', ')} — or leave it blank.` });
    }
    const now = new Date();
    const row = await this.prisma.recruitment_onboarding_marks.upsert({
      where: { person_id_step_id: { person_id: personId, step_id: stepId } },
      create: { person_id: personId, step_id: stepId, value, updated_by: user.name ?? null, updated_at: now },
      update: { value, updated_by: user.name ?? null, updated_at: now },
    });
    return { data: { person_id: row.person_id, step_id: row.step_id, value: row.value, updated_by: row.updated_by, updated_at: row.updated_at } };
  }

  async addPerson(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { name, tag } = this.personFields(body);
    const now = new Date();
    const row = await this.prisma.recruitment_onboarding_people.create({
      data: { name, tag, added_by: user.name ?? null, created_at: now, updated_at: now },
    });
    return { data: { id: row.id, name: row.name, tag: row.tag, candidate_id: null, candidate_status: null, marks: {} } };
  }

  async updatePerson(personId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const person = await this.prisma.recruitment_onboarding_people.findFirst({ where: { id: personId, removed_at: null } });
    if (!person) throw new NotFoundException({ message: 'That agent is not on the onboarding list.' });
    const { name, tag } = this.personFields(body);
    const row = await this.prisma.recruitment_onboarding_people.update({ where: { id: personId }, data: { name, tag, updated_at: new Date() } });
    return { data: { id: row.id, name: row.name, tag: row.tag } };
  }

  /** Off the list, marks kept. Administrators only. */
  async removePerson(user: AuthUserRecord, personId: number): Promise<Record<string, unknown>> {
    this.assertManager(user);
    const person = await this.prisma.recruitment_onboarding_people.findFirst({ where: { id: personId, removed_at: null } });
    if (!person) throw new NotFoundException({ message: 'That agent is not on the onboarding list.' });
    const now = new Date();
    await this.prisma.recruitment_onboarding_people.update({ where: { id: personId }, data: { removed_at: now, updated_at: now } });
    return { removed: true };
  }

  private personFields(body: Record<string, unknown>): { name: string; tag: string | null } {
    const name = oneLine(body.name);
    if (!name) throw new BadRequestException({ message: 'Enter the agent\'s name.' });
    if (name.length > ONBOARDING_IMPORT_LIMITS.name) throw new BadRequestException({ message: `The name is longer than ${ONBOARDING_IMPORT_LIMITS.name} characters.` });
    const tag = oneLine(body.tag).toUpperCase();
    if (tag.length > 16) throw new BadRequestException({ message: 'The tag is longer than 16 characters.' });
    return { name, tag: tag || null };
  }

  // ------------------------------------------------------------------------------- the step list

  async addStep(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertManager(user);
    const kind = str(body.kind) as OnboardingKind;
    if (!ONBOARDING_KINDS.includes(kind)) throw new BadRequestException({ message: 'A step is either onboarding or training.' });
    const title = this.titleOf(body.title);
    const last = await this.prisma.recruitment_onboarding_steps.aggregate({ where: { kind }, _max: { position: true } });
    const now = new Date();
    const row = await this.prisma.recruitment_onboarding_steps.create({
      data: { kind, title, position: (last._max.position ?? 0) + 1, created_by: user.name ?? null, created_at: now, updated_at: now },
    });
    return { data: { id: row.id, kind: row.kind, title: row.title, position: row.position, hidden: false } };
  }

  /** Rename (`title`), hide or show again (`hidden`), or move one place (`move: up | down`) within its kind. */
  async updateStep(user: AuthUserRecord, stepId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertManager(user);
    const step = await this.prisma.recruitment_onboarding_steps.findUnique({ where: { id: stepId } });
    if (!step) throw new NotFoundException({ message: 'That step does not exist.' });
    const now = new Date();
    const data: Prisma.recruitment_onboarding_stepsUpdateInput = { updated_at: now };
    if (body.title !== undefined) data.title = this.titleOf(body.title);
    if (body.hidden !== undefined) data.hidden_at = body.hidden === true || body.hidden === 'true' ? (step.hidden_at ?? now) : null;
    const move = str(body.move);
    if (move && move !== 'up' && move !== 'down') throw new BadRequestException({ message: 'Move a step up or down.' });

    await this.prisma.$transaction(async (tx) => {
      if (move) {
        // Renumber the kind 1..n in its current order, then swap with the neighbour — positions that
        // were equal or gapped (an import, two adds at once) cannot leave the move doing nothing.
        const all = await tx.recruitment_onboarding_steps.findMany({ where: { kind: step.kind }, orderBy: [{ position: 'asc' }, { id: 'asc' }] });
        const order = all.map((s) => s.id);
        const i = order.indexOf(step.id);
        const j = move === 'up' ? i - 1 : i + 1;
        if (j >= 0 && j < order.length) [order[i], order[j]] = [order[j], order[i]];
        for (let k = 0; k < order.length; k += 1) {
          await tx.recruitment_onboarding_steps.update({ where: { id: order[k] }, data: { position: k + 1 } });
        }
      }
      await tx.recruitment_onboarding_steps.update({ where: { id: stepId }, data });
    });
    const row = await this.prisma.recruitment_onboarding_steps.findUniqueOrThrow({ where: { id: stepId } });
    return { data: { id: row.id, kind: row.kind, title: row.title, position: row.position, hidden: !!row.hidden_at } };
  }

  private titleOf(v: unknown): string {
    const title = oneLine(v);
    if (!title) throw new BadRequestException({ message: 'A step needs a title.' });
    if (title.length > ONBOARDING_IMPORT_LIMITS.title) throw new BadRequestException({ message: `The title is longer than ${ONBOARDING_IMPORT_LIMITS.title} characters.` });
    return title;
  }

  // ------------------------------------------------------------------------------- the sheet import

  /*
   * IMPORT THE "Onboarding & Trainings" WORKBOOK. Reads two tabs and ignores the rest:
   *   NEW ONBOARD TASK SHEET  one row per agent, one column per onboarding step
   *   Training topics         one row per topic, one column per agent (the other way round)
   * The older "Onboard Tasks" tab is the first one with rows and columns swapped, and NEW AGENT DATA is
   * not onboarding; both are reported as ignored.
   *
   * IT ONLY FILLS BLANKS. A cell the CRM already has a value for keeps the CRM's value even when the sheet
   * says otherwise, so importing an old copy of the sheet can never undo work done on the screen. People
   * are matched by name; a training-tab name with no match on the onboarding tab is matched only as the
   * administrator chose in the preview (`matches`), never by guesswork on the server.
   *
   * Preview writes nothing. Import re-reads the file and re-checks everything inside one transaction,
   * under an advisory lock, so a double click or a second administrator cannot import it twice.
   */

  async importPreview(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertManager(user);
    const sheets = await readWorkbook(String(body.filename ?? ''), String(body.content_base64 ?? ''));
    const plan = await this.plan(this.prisma, sheets, null);
    return plan.summary;
  }

  async importSheet(user: AuthUserRecord, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertManager(user);
    const sheets = await readWorkbook(String(body.filename ?? ''), String(body.content_base64 ?? ''));
    const matches = parseMatches(body.matches);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('recruitment-onboarding-import'))`;
      const plan = await this.plan(tx, sheets, matches);
      const now = new Date();
      const idFor = new Map<string, number>();
      for (const [key, id] of plan.existingIds) idFor.set(key, id);
      for (const p of plan.toCreate) {
        const row = await tx.recruitment_onboarding_people.create({
          data: { name: p.name.slice(0, ONBOARDING_IMPORT_LIMITS.name), tag: p.tag, added_by: user.name ?? null, created_at: now, updated_at: now },
        });
        idFor.set(p.key, row.id);
      }
      const data = plan.marks.map((m) => ({
        person_id: idFor.get(m.personKey) as number, step_id: m.stepId, value: m.value, updated_by: user.name ?? null, updated_at: now,
      }));
      const created = data.length ? await tx.recruitment_onboarding_marks.createMany({ data, skipDuplicates: true }) : { count: 0 };
      return { ...plan.summary, imported: { people: plan.toCreate.length, marks: created.count } };
    }, { timeout: 60_000 });
  }

  /**
   * Work out what an import would do. `matches` null = preview (report the suggested matches); otherwise
   * the administrator's choices, each validated against the same pool the preview offered.
   */
  private async plan(db: Db, s: ReadSheets, matches: Map<string, string> | null) {
    const steps = await db.recruitment_onboarding_steps.findMany();
    const stepBy = { onboarding: new Map<string, number>(), training: new Map<string, number>() };
    for (const st of steps) {
      const map = stepBy[st.kind as OnboardingKind];
      // A hidden step still takes its column: hiding is about the screen, not about losing data.
      if (map && !map.has(titleKey(st.title))) map.set(titleKey(st.title), st.id);
    }
    const unknownColumns = [...s.unknownColumns];
    const seenUnknown = new Set(unknownColumns.map((u) => `${u.sheet}|${u.title}`));
    const cellsWithStep = (kind: OnboardingKind, sheet: string | null) => s.cells[kind].flatMap((c) => {
      const id = stepBy[kind].get(titleKey(c.step));
      if (!id) {
        const k = `${sheet}|${c.step}`;
        if (!seenUnknown.has(k)) { seenUnknown.add(k); unknownColumns.push({ sheet: sheet ?? '', title: c.step }); }
        return [];
      }
      return [{ ...c, stepId: id }];
    });
    const obCells = cellsWithStep('onboarding', s.onboardingSheet);
    const trCells = cellsWithStep('training', s.trainingSheet);

    const existing = await db.recruitment_onboarding_people.findMany({ where: { removed_at: null }, select: { id: true, name: true }, orderBy: { id: 'asc' } });
    const existingIds = new Map<string, number>();
    for (const p of existing) if (!existingIds.has(nameKey(p.name))) existingIds.set(nameKey(p.name), p.id);

    // Who the training tab's names are. Matched by name to the onboarding tab or to the CRM; the rest
    // are offered to the administrator, each with a suggestion when exactly one name shares the most words.
    const pool = new Map<string, string>();
    for (const [k, v] of s.onboardingNames) if (!s.trainingNames.has(k)) pool.set(k, v.name);
    for (const p of existing) { const k = nameKey(p.name); if (!s.trainingNames.has(k) && !pool.has(k)) pool.set(k, p.name); }
    const unmatched = [...s.trainingNames.entries()]
      .filter(([k]) => !s.onboardingNames.has(k) && !existingIds.has(k))
      .map(([k, v]) => ({ key: k, name: v.name, suggestion: suggest(k, pool) }));

    const resolved = new Map<string, string>();   // training key → the person key it lands on
    if (matches) {
      const used = new Map<string, string>();
      for (const u of unmatched) {
        const target = matches.get(u.key) ?? '';
        if (target && !pool.has(target)) throw new BadRequestException({ message: `"${u.name}" was matched to a name that is not in the list. Check the file again.` });
        if (target) {
          if (used.has(target)) throw new BadRequestException({ message: `"${used.get(target)}" and "${u.name}" cannot both be matched to "${pool.get(target)}".` });
          used.set(target, u.name);
          resolved.set(u.key, target);
        }
      }
    } else {
      for (const u of unmatched) if (u.suggestion) resolved.set(u.key, u.suggestion);
    }

    // The people this import creates: every onboarding-tab name not in the CRM, and every training-tab
    // name that is neither on the onboarding tab, in the CRM, nor matched to one of them.
    const toCreate: { key: string; name: string; tag: string | null }[] = [];
    const creating = new Set<string>();
    const tagOf = (k: string) => s.onboardingNames.get(k)?.tag ?? s.trainingNames.get(k)?.tag ?? null;
    for (const [k, v] of s.onboardingNames) {
      if (!existingIds.has(k) && !creating.has(k)) { creating.add(k); toCreate.push({ key: k, name: v.name, tag: tagOf(k) }); }
    }
    for (const [k, v] of s.trainingNames) {
      const target = resolved.get(k) ?? k;
      if (!existingIds.has(target) && !creating.has(target)) {
        creating.add(target);
        toCreate.push({ key: target, name: target === k ? v.name : (pool.get(target) ?? v.name), tag: tagOf(target) ?? v.tag });
      }
    }

    // Marks: only where the CRM has none. The first value for a cell wins within the file.
    const existingPersonIds = [...new Set([...existingIds.values()])];
    const current = existingPersonIds.length
      ? await db.recruitment_onboarding_marks.findMany({ where: { person_id: { in: existingPersonIds } }, select: { person_id: true, step_id: true, value: true } })
      : [];
    const currentBy = new Map(current.map((m) => [`${m.person_id}|${m.step_id}`, m.value]));
    const marks: { personKey: string; stepId: number; value: string }[] = [];
    const planned = new Set<string>();
    let same = 0;
    let kept = 0;
    const take = (personKey: string, stepId: number, value: string) => {
      const k = `${personKey}|${stepId}`;
      if (planned.has(k)) return;
      planned.add(k);
      const pid = existingIds.get(personKey);
      const had = pid ? currentBy.get(`${pid}|${stepId}`) : undefined;
      if (had === value) { same += 1; return; }
      if (had !== undefined) { kept += 1; return; }
      marks.push({ personKey, stepId, value });
    };
    for (const c of obCells) take(c.person, c.stepId, c.value);
    for (const c of trCells) take(resolved.get(c.person) ?? c.person, c.stepId, c.value);

    const people = new Set([...s.onboardingNames.keys(), ...[...s.trainingNames.keys()].map((k) => resolved.get(k) ?? k)]);
    const summary = {
      sheets: { onboarding: s.onboardingSheet, training: s.trainingSheet },
      ignored_sheets: s.ignoredSheets,
      people: { total: people.size, new: toCreate.length, existing: people.size - toCreate.length },
      marks: { new: marks.length, already_same: same, kept_crm_value: kept },
      unknown_columns: unknownColumns,
      unknown_values: s.unknownValues.slice(0, 50),
      unknown_value_count: s.unknownValues.length,
      unmatched: unmatched.map((u) => ({ key: u.key, name: u.name, suggestion: u.suggestion })),
      pool: [...pool.entries()].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
    return { summary, toCreate, existingIds, marks };
  }
}

/** The pool entry sharing the most words (3+ letters) with `key`, when exactly one does. */
function suggest(key: string, pool: Map<string, string>): string | null {
  const words = (k: string) => new Set(k.split(' ').filter((w) => w.length >= 3));
  const mine = words(key);
  let best = 0;
  let hits: string[] = [];
  for (const k of pool.keys()) {
    const n = [...words(k)].filter((w) => mine.has(w)).length;
    if (n > best) { best = n; hits = [k]; } else if (n === best && n > 0) hits.push(k);
  }
  return best > 0 && hits.length === 1 ? hits[0] : null;
}

function parseMatches(v: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) out.set(nameKey(k), nameKey(t));
  }
  return out;
}

const cellText = (cell: ExcelJS.Cell): string => {
  const v = cell.value as unknown;
  if (v && typeof v === 'object' && 'richText' in (v as Record<string, unknown>)) {
    return ((v as { richText: { text: string }[] }).richText ?? []).map((r) => r.text).join('');
  }
  return cell.text ?? '';
};

/** Read and check the workbook. Throws a 400 a person can act on when it is not the sheet. */
export async function readWorkbook(filename: string, contentBase64: string): Promise<ReadSheets> {
  if (!filename.toLowerCase().endsWith('.xlsx')) throw new BadRequestException({ message: 'Upload the Excel workbook (.xlsx).' });
  const b64 = String(contentBase64 ?? '');
  if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new BadRequestException({ message: 'No file was received.' });
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) throw new BadRequestException({ message: 'The file is empty.' });
  if (buffer.length > ONBOARDING_IMPORT_LIMITS.maxFileBytes) throw new BadRequestException({ message: 'The file is larger than 2 MB.' });
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw new BadRequestException({ message: 'That file is not a real .xlsx workbook. Save it from Excel as "Excel Workbook (.xlsx)".' });
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException({ message: 'That file could not be read as an Excel workbook (.xlsx).' });
  }

  const out: ReadSheets = {
    onboardingSheet: null, trainingSheet: null, ignoredSheets: [],
    onboardingNames: new Map(), trainingNames: new Map(),
    cells: { onboarding: [], training: [] }, unknownColumns: [], unknownValues: [],
  };
  const sheetKey = (n: string) => n.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const ws of wb.worksheets) {
    const key = sheetKey(ws.name);
    if (key === 'new onboard task sheet' && !out.onboardingSheet) out.onboardingSheet = ws.name;
    else if (key === 'training topics' && !out.trainingSheet) out.trainingSheet = ws.name;
    else out.ignoredSheets.push(ws.name);
  }
  if (!out.onboardingSheet && !out.trainingSheet) {
    throw new BadRequestException({ message: 'The workbook needs a "NEW ONBOARD TASK SHEET" tab or a "Training topics" tab, as in the Onboarding & Trainings sheet.' });
  }

  const value = (sheet: string, cell: ExcelJS.Cell, kind: OnboardingKind): string => {
    const raw = cellText(cell);
    const v = readValue(raw);
    if (v === null || (v && !ONBOARDING_VALUES[kind].includes(v))) {
      out.unknownValues.push({ sheet, cell: cell.address, value: oneLine(raw).slice(0, 60) });
      return '';
    }
    return v;
  };

  if (out.onboardingSheet) {
    const ws = wb.getWorksheet(out.onboardingSheet) as ExcelJS.Worksheet;
    const titles: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { if (col > 1) titles[col] = oneLine(cellText(cell)); });
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (r === 1) return;
      const { name, tag } = splitName(cellText(row.getCell(1)));
      if (!name) return;
      const key = nameKey(name);
      if (!out.onboardingNames.has(key)) out.onboardingNames.set(key, { name, tag });
      for (let col = 2; col < titles.length; col += 1) {
        if (!titles[col]) continue;
        const v = value(out.onboardingSheet as string, row.getCell(col), 'onboarding');
        if (v) out.cells.onboarding.push({ person: key, tag, step: titles[col], value: v, cell: row.getCell(col).address });
      }
    });
  }

  if (out.trainingSheet) {
    const ws = wb.getWorksheet(out.trainingSheet) as ExcelJS.Worksheet;
    const names: { key: string; tag: string | null }[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      if (col === 1) return;
      const { name, tag } = splitName(cellText(cell));
      if (!name) return;
      const key = nameKey(name);
      names[col] = { key, tag };
      if (!out.trainingNames.has(key)) out.trainingNames.set(key, { name, tag });
    });
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (r === 1) return;
      const title = oneLine(cellText(row.getCell(1)));
      if (!title) return;
      for (let col = 2; col < names.length; col += 1) {
        if (!names[col]) continue;
        const v = value(out.trainingSheet as string, row.getCell(col), 'training');
        if (v) out.cells.training.push({ person: names[col].key, tag: names[col].tag, step: title, value: v, cell: row.getCell(col).address });
      }
    });
  }

  if (out.onboardingNames.size + out.trainingNames.size === 0) throw new BadRequestException({ message: 'The sheet has no agents in it.' });
  if (out.onboardingNames.size > ONBOARDING_IMPORT_LIMITS.maxPeople || out.trainingNames.size > ONBOARDING_IMPORT_LIMITS.maxPeople) {
    throw new BadRequestException({ message: `The sheet has more than ${ONBOARDING_IMPORT_LIMITS.maxPeople} agents.` });
  }
  return out;
}
