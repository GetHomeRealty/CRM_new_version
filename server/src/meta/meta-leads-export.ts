import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import type { AuthUserRecord } from '../auth/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { liveLeadWhere } from '../common/lead-scope';

/**
 * EVERY META LEAD THIS PERSON CAN SEE, AS A SPREADSHEET (brokerage request, 2026-10-19).
 *
 * The Meta screen lists recent leads with only their newest note; this is the whole set, with EVERY
 * note on each lead, newest first, beside its status and who it is assigned to.
 *
 * THE SAME SCOPE AS THE LIST (`GET /meta/leads`): Meta source, `liveLeadWhere` for who may see what,
 * and the Page and form the screen is showing — so the file holds exactly the leads the screen would.
 * Read-only: nothing here writes, and nothing is sent to Meta.
 */

/** Excel refuses a cell longer than this; a lead with that much written about it says so in the cell. */
const CELL_MAX = 32_000;

/**
 * Excel runs a cell that starts with `=` or `@` (and `+`/`-` before anything but a number) as a
 * formula. A phone number such as +13475919332 is left as it is.
 */
const safe = (v: string): string => (/^[=@]/.test(v) || /^[+-](?![\d(])/.test(v) ? `'${v}` : v);

const COLUMNS: { header: string; key: string; width: number }[] = [
  { header: 'Lead ID', key: 'id', width: 9 },
  { header: 'Name', key: 'name', width: 26 },
  { header: 'Email', key: 'email', width: 30 },
  { header: 'Phone', key: 'phone', width: 17 },
  { header: 'Enquiry', key: 'enquiry', width: 36 },
  { header: 'Status', key: 'status', width: 14 },
  { header: 'Assigned To', key: 'assigned', width: 20 },
  { header: 'Meta Page', key: 'page', width: 22 },
  { header: 'Lead Form', key: 'form', width: 30 },
  { header: 'Received', key: 'received', width: 18 },
  { header: 'Latest Note', key: 'latest', width: 48 },
  { header: 'Latest Note By', key: 'latest_by', width: 18 },
  { header: 'Latest Note Date', key: 'latest_at', width: 18 },
  { header: 'Number of Notes', key: 'note_count', width: 10 },
  { header: 'All Notes (newest first)', key: 'all_notes', width: 80 },
];

/** "2026-10-19 09:02", in the server's time zone — the same shape the screen's Received column shows. */
const stamp = (d: Date | null | undefined): string => {
  if (!d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export async function buildMetaLeadsXlsx(
  prisma: PrismaService,
  user: AuthUserRecord,
  filter: { pageId?: string | null; formId?: string | null },
): Promise<{ buffer: Buffer; filename: string; count: number }> {
  const and: Prisma.leadsWhereInput[] = [{ source: 'facebook_meta' }, liveLeadWhere(user)];
  if (filter.pageId) and.push({ facebook_page_id: filter.pageId });
  if (filter.formId) and.push({ facebook_form_id: filter.formId });

  const leads = await prisma.leads.findMany({
    where: { AND: and },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    select: {
      id: true, name: true, email: true, phone: true, message: true, property: true, lead_status: true,
      assigned_to: true, created_at: true, facebook_form_id: true, facebook_page_id: true,
    },
  });
  const ids = leads.map((l) => l.id);

  const [notes, users, inquiries] = ids.length ? await Promise.all([
    prisma.lead_notes.findMany({
      where: { lead_id: { in: ids } },
      orderBy: [{ lead_id: 'asc' }, { created_at: 'desc' }, { id: 'desc' }],
      select: { lead_id: true, content: true, created_by: true, created_at: true },
    }),
    prisma.users.findMany({
      where: { id: { in: [...new Set(leads.map((l) => l.assigned_to).filter((n): n is number => typeof n === 'number' && n > 0))] } },
      select: { id: true, name: true },
    }),
    // The form and Page NAMES each lead arrived under, newest submission first.
    prisma.meta_lead_inquiries.findMany({
      where: { lead_id: { in: ids } },
      orderBy: [{ lead_id: 'asc' }, { id: 'desc' }],
      select: { lead_id: true, meta_form_name: true, meta_page_name: true },
    }),
  ]) : [[], [], []];

  const notesBy = new Map<number, typeof notes>();
  for (const n of notes) notesBy.set(n.lead_id, [...(notesBy.get(n.lead_id) ?? []), n]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const inquiryBy = new Map<number, (typeof inquiries)[number]>();
  for (const q of inquiries) if (!inquiryBy.has(q.lead_id)) inquiryBy.set(q.lead_id, q);

  const book = new ExcelJS.Workbook();
  book.created = new Date();
  const sheet = book.addWorksheet('Meta Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = COLUMNS;
  sheet.getRow(1).font = { bold: true };

  for (const l of leads) {
    const own = notesBy.get(l.id) ?? [];
    const latest = own[0];
    let all = own.map((n) => `${stamp(n.created_at)} — ${n.created_by || 'Someone'}: ${n.content}`).join('\n\n');
    if (all.length > CELL_MAX) all = `${all.slice(0, CELL_MAX)}\n… (more notes on the lead in the CRM)`;
    const q = inquiryBy.get(l.id);
    const row = sheet.addRow({
      id: l.id,
      name: safe(l.name ?? ''),
      email: safe((l.email ?? '').endsWith('@meta.invalid') ? '' : (l.email ?? '')),
      phone: safe(l.phone ?? ''),
      enquiry: safe(l.message || l.property || ''),
      status: safe(l.lead_status ?? ''),
      assigned: safe(l.assigned_to ? names.get(l.assigned_to) ?? '' : 'Unassigned'),
      page: safe(q?.meta_page_name || l.facebook_page_id || ''),
      form: safe(q?.meta_form_name || l.facebook_form_id || ''),
      received: stamp(l.created_at),
      latest: safe(latest?.content ?? ''),
      latest_by: safe(latest?.created_by ?? ''),
      latest_at: stamp(latest?.created_at),
      note_count: own.length,
      all_notes: safe(all),
    });
    row.alignment = { vertical: 'top', wrapText: true };
  }
  if (leads.length) sheet.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };

  return {
    buffer: Buffer.from(await book.xlsx.writeBuffer()),
    filename: `Meta Leads ${stamp(new Date()).slice(0, 10)}.xlsx`,
    count: leads.length,
  };
}
