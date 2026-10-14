import type { TransactionDocuments } from './transactions-api';
// The server provides the canonical type/status selection; retain all other metadata.
export function applyChecklistVisibility(payload: TransactionDocuments & { visible_document_ids?: unknown }): TransactionDocuments {
 if (payload.visible_document_ids === undefined) return payload;
 const ids = payload.visible_document_ids;
 if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length || ids.some(id => !payload.documents.some(doc => doc.id === id))) throw new Error('Checklist visibility changed. Refresh the transaction.');
 const visible = new Set<number>(ids);
 const documents = payload.documents.filter(doc => visible.has(doc.id));
 const total = documents.length, received = documents.filter(doc => doc.status === 'Received').length;
 return { ...payload, documents, stats: { total, received, pending: total - received, mandatory: documents.filter(doc => doc.mandatory).length, pct: total ? Math.round(received / total * 100) : 0 } };
}
