import ExcelJS from 'exceljs';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { buildMetaLeadsXlsx } from './meta-leads-export';

/**
 * THE META LEADS DOWNLOAD (2026-10-19): every lead the viewer can see, with ALL its notes newest
 * first, its status and who it is assigned to — narrowed by Page and form like the list, and never
 * holding a lead the viewer's scope hides. Real tables, rolled back.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

async function readSheet(buffer: Buffer): Promise<Record<string, unknown>[]> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = book.getWorksheet('Meta Leads')!;
  const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const v = (row.values as unknown[]).slice(1);
    rows.push(Object.fromEntries(headers.map((h, i) => [h, v[i] ?? ''])));
  });
  return rows;
}

async function scene(tx: PrismaService) {
  const now = new Date();
  const t = tag();
  const user = (name: string, role: string) => tx.users.create({
    data: { name: `${name} ${t}`, email: `zz-export-${role}-${tag()}@probe.test`, password: 'x', role, status: 'Active', created_at: now, updated_at: now },
    select: { id: true, name: true, role: true },
  });
  const admin = await user('ZZ Admin', 'admin');
  const agent = await user('ZZ Agent', 'agent');
  const other = await user('ZZ Other', 'agent');
  const page = `page-${t}`;
  const form = `form-${t}`;
  const lead = (name: string, assigned: number | null, formId = form) => tx.leads.create({
    data: {
      name, email: `l-${tag()}@probe.test`, phone: '+13475919332', source: 'facebook_meta', lead_status: 'cold',
      facebook_page_id: page, facebook_form_id: formId, facebook_lead_id: `fb-${tag()}`, assigned_to: assigned,
      created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  const mine = await lead('ZZ Mine', agent.id);
  const theirs = await lead('ZZ Theirs', other.id, `other-${t}`);
  const note = (leadId: number, content: string, minutesAgo: number) => tx.lead_notes.create({
    data: { lead_id: leadId, content, created_by: 'Vishnu', created_at: new Date(now.getTime() - minutesAgo * 60_000) },
  });
  await note(mine.id, 'First call, no answer', 60);
  await note(mine.id, 'Shared Mokila and Maheshwaram details', 5);
  const as = (u: { id: number; name: string; role: string }) =>
    ({ id: u.id, name: u.name, role: u.role, user_permissions: [] }) as unknown as AuthUserRecord;
  return { admin, agent, other, page, form, mine, theirs, as };
}

describe('Meta leads download', () => {
  it('holds every note newest first, the status and the assignee', async () => {
    await inRollback(async (tx) => {
      const s = await scene(tx);
      const { buffer } = await buildMetaLeadsXlsx(tx, s.as(s.admin), { pageId: s.page });
      const rows = await readSheet(buffer);
      const mine = rows.find((r) => r['Lead ID'] === s.mine.id)!;
      expect(mine).toBeTruthy();
      expect(mine.Status).toBe('cold');
      expect(mine['Assigned To']).toBe(s.agent.name);
      expect(mine.Phone).toBe('+13475919332');   // a phone number is not treated as a formula
      expect(mine['Latest Note']).toBe('Shared Mokila and Maheshwaram details');
      expect(mine['Number of Notes']).toBe(2);
      const all = String(mine['All Notes (newest first)']);
      expect(all.indexOf('Shared Mokila')).toBeLessThan(all.indexOf('First call'));
      expect(rows.some((r) => r['Lead ID'] === s.theirs.id)).toBe(true);
    });
  });

  it('narrows to the form, and an agent only gets the leads their scope allows', async () => {
    await inRollback(async (tx) => {
      const s = await scene(tx);
      const byForm = await readSheet((await buildMetaLeadsXlsx(tx, s.as(s.admin), { pageId: s.page, formId: s.form })).buffer);
      expect(byForm.map((r) => r['Lead ID'])).toEqual([s.mine.id]);

      const agentRows = await readSheet((await buildMetaLeadsXlsx(tx, s.as(s.agent), { pageId: s.page })).buffer);
      expect(agentRows.some((r) => r['Lead ID'] === s.mine.id)).toBe(true);
      expect(agentRows.some((r) => r['Lead ID'] === s.theirs.id)).toBe(false);
    });
  });
});
