import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { parseJsonObject, phpJsonNormalize } from '../common/serialize';
import { ROLE_LABELS } from '../auth/permission.service';
import { latestAdminNote, latestNoteIndex } from './report-data.service';

export type RemarkField = 'validation_comments' | 'accounting_remarks';

/** Who may write each field from the Pending Payments report. */
const WRITERS: Record<RemarkField, readonly string[]> = {
  // Final Validation Remarks is a readiness field, which Documentation also sets in the panel.
  validation_comments: ['admin', 'manager', 'accounting', 'documentation'],
  accounting_remarks: ['admin', 'manager', 'accounting'],
};

const MAX_LENGTH = 5000;

/**
 * The two text fields the Pending Payments report edits in place.
 *
 * WHY THIS IS NOT THE ORDINARY TRANSACTION UPDATE. Every deal in that report is Closed, and a Closed
 * deal refuses every save except a Super Admin's — so Accounting, whose report it is, could not
 * correct a comment there at all. This route is the narrow exception the brokerage asked for
 * (2026-10-15): it writes ONLY Agent Payment Readiness → Final Validation Remarks and the Admin
 * Activities Remarks note, both free text. No amount, status or date moves, and nothing else in
 * either panel is read back from the browser — the deal is read here, one field changed, written
 * back. Every change goes in the deal's Audit Trail with its old and new text.
 */
@Injectable()
export class ReportRemarksService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async save(user: AuthUserRecord, transactionId: number, field: RemarkField, rawText: unknown): Promise<{ value: string | null }> {
    if (!(field in WRITERS)) throw new BadRequestException({ message: 'Unknown field.' });
    if (!WRITERS[field].includes(user.role ?? '')) {
      throw new ForbiddenException({ message: 'You cannot edit this field.' });
    }
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (text.length > MAX_LENGTH) throw new BadRequestException({ message: `Keep it to ${MAX_LENGTH.toLocaleString()} characters.` });

    return this.prisma.$transaction(async (tx) => {
      // Locked for the read-modify-write, so two people saving at once cannot drop each other's change.
      await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${transactionId} FOR UPDATE`;
      const t = await tx.transactions.findFirst({
        where: { id: transactionId, deleted_at: null },
        select: { id: true, type: true, activity_tracker: true, admin_activities: true },
      });
      if (!t) throw new NotFoundException({ message: 'Transaction not found.' });
      const actor = { id: user.id, name: user.name };
      const now = new Date();

      if (field === 'validation_comments') {
        // A preconstruction deal keeps validation per term; this report cannot say which term.
        if (t.type === 'Preconstruction') throw new BadRequestException({ message: 'Set this per term in Agent Payment Readiness.' });
        const tracker = parseJsonObject(t.activity_tracker);
        const old = typeof tracker.final_validation_remarks === 'string' ? tracker.final_validation_remarks : '';
        if (old === text) return { value: text || null };
        tracker.final_validation_remarks = text;
        await tx.transactions.update({ where: { id: t.id }, data: { activity_tracker: JSON.stringify(phpJsonNormalize(tracker)), updated_at: now } });
        await this.audit.record(t.id, actor, {
          section: 'Agent Payment Readiness', field: 'Final Validation Remarks', old, new: text,
          action: 'Updated', source: 'Pending Payments report',
        }, tx);
        return { value: text || null };
      }

      // accounting_remarks — the note the report shows is the newest one, and that is the one edited.
      const admin = parseJsonObject(t.admin_activities);
      const notes = Array.isArray(admin.notes) ? [...admin.notes] as Record<string, unknown>[] : [];
      const i = latestNoteIndex(notes);
      const old = i === -1 ? '' : String(notes[i].text ?? '').trim();
      if (old === text) return { value: latestAdminNote(admin) };
      if (!text) {
        notes.splice(i, 1); // cleared: the note goes
      } else {
        const stamped = { text, date: now.toISOString().slice(0, 10), created_at: now.toISOString(), author: user.name, role: ROLE_LABELS[user.role ?? ''] ?? (user.role ?? '') };
        if (i === -1) notes.push(stamped);
        else notes[i] = { ...notes[i], ...stamped };
      }
      admin.notes = notes;
      await tx.transactions.update({ where: { id: t.id }, data: { admin_activities: JSON.stringify(phpJsonNormalize(admin)), updated_at: now } });
      await this.audit.record(t.id, actor, {
        section: 'Admin Activities', field: 'Remarks', old, new: text,
        action: text ? 'Updated' : 'Deleted', source: 'Pending Payments report',
      }, tx);
      return { value: latestAdminNote(admin) };
    });
  }
}
