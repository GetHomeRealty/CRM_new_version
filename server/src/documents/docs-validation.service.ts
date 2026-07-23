import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type ActingUser } from '../audit/audit.service';
import { parseJsonObject, phpJsonNormalize } from '../common/serialize';

interface DocRow { status: string; validation: string }

/**
 * Keeps the Agent FAQ Center in sync with the Legal & Documentation checklist
 * (port of DocsValidationService). When every document is Received + Valid,
 * "Valid Docs Cleared from Agent" auto-sets to Yes; reverts to No otherwise.
 */
@Injectable()
export class DocsValidationService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async sync(txnId: number, actor: ActingUser | null): Promise<void> {
    const txn = await this.prisma.transactions.findUnique({ where: { id: txnId }, select: { type: true, activity_tracker: true, precon_term_count: true } });
    if (!txn) return;

    const docs = (await this.prisma.documents.findMany({ where: { transaction_id: txnId, deleted_at: null }, select: { status: true, validation: true } })) as DocRow[];
    const cleared = docs.length > 0 && docs.every((d) => d.status === 'Received' && d.validation === 'Valid');

    const tracker = parseJsonObject(txn.activity_tracker) as Record<string, unknown>;
    const audits: { field: string; old: string; new: string }[] = [];

    const apply = (node: Record<string, unknown>, label: string): Record<string, unknown> => {
      const target = cleared ? 'Yes' : 'No';
      const old = (node.docs_cleared as string) ?? '';
      if (old === target) return node;
      node.docs_cleared = target;
      audits.push({ field: `${label} Valid Docs Cleared from Agent`.trim(), old, new: target });

      const fv = (node.final_validation as string) ?? '';
      if (cleared && fv !== 'Done' && fv !== 'Pending') {
        node.final_validation = 'Pending';
        audits.push({ field: `${label} Final Validation`.trim(), old: fv, new: 'Pending' });
      }
      return node;
    };

    apply(tracker, '');

    if (txn.type === 'Preconstruction') {
      const count = Number(txn.precon_term_count ?? 0);
      const terms = (tracker.term_tracker as Record<string, unknown>) ?? {};
      for (let k = 1; k <= count; k++) {
        terms[k] = apply((typeof terms[k] === 'object' && terms[k] !== null ? terms[k] : {}) as Record<string, unknown>, `Term ${k} —`);
      }
      if (count > 0) tracker.term_tracker = terms;
    }

    if (audits.length === 0) return;

    await this.prisma.transactions.update({ where: { id: txnId }, data: { activity_tracker: JSON.stringify(phpJsonNormalize(tracker)), updated_at: new Date() } });

    for (const a of audits) {
      await this.audit.record(txnId, actor, { section: 'Quick Actions — Agent FAQ', source: 'System', action: 'Status changed', field: a.field, old: a.old, new: a.new });
    }
  }
}
