import { DocumentsService } from './documents.service';
import type { AuthUserRecord } from '../auth/auth.types';
import type { documents } from '@prisma/client';

const AGENT = { id: 17, name: 'Test Agent', role: 'agent' } as AuthUserRecord;
const ADMIN = { id: 1, name: 'Admin', role: 'admin' } as AuthUserRecord;
const upload = { originalname: 'offer.pdf', buffer: Buffer.from('%PDF-1.4 test') };
const base = (): documents => ({ id: 4, transaction_id: 8, title: 'Offer Summary', is_condition: false,
  mandatory: true, status: 'Pending', validation: 'Pending', agent_accepted: null,
  deleted_at: null, file_path: null, file_name: null, files: null, draft_files: null,
  position: 0 } as documents);

function setup(overrides: Partial<documents> = {}) {
  let rows = [{ ...base(), ...overrides }];
  const match = (row: documents, where: Record<string, any>) => Object.entries(where).every(([key, value]) => {
    const actual = (row as any)[key];
    return value && typeof value === 'object' && 'not' in value ? actual !== value.not : actual === value;
  });
  const db: any = {
    transactions: { findFirst: jest.fn(async () => ({ id: 8, agent: AGENT.name, agent_user_id: AGENT.id })), findUnique: jest.fn(async () => ({})) },
    team_members: { findFirst: jest.fn(async () => null) },
    clients: { findFirst: jest.fn(async () => ({ name: 'Alex' })), findMany: jest.fn(async () => [{ name: 'Alex' }]) },
    conditions: { findMany: jest.fn(async () => []) },
    documents: {
      findFirst: jest.fn(async ({ where }) => { const r = rows.find((row) => match(row, where)); return r ? { ...r } : null; }),
      findMany: jest.fn(async ({ where }) => rows.filter((r) => match(r, where)).map((r) => ({ ...r }))),
      aggregate: jest.fn(async () => ({ _max: { position: rows.length } })),
      create: jest.fn(async ({ data }) => { const row = { ...base(), ...data, id: rows.length + 10 }; rows.push(row); return row; }),
      update: jest.fn(async ({ where, data }) => { const row = rows.find((r) => r.id === where.id)!; Object.assign(row, data); return row; }),
      updateMany: jest.fn(async ({ where, data }) => { const found = rows.filter((r) => match(r, where)); found.forEach((r) => Object.assign(r, data)); return { count: found.length }; }),
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const before = rows.map((r) => ({ ...r }));
      try { return await fn(db); } catch (error) { rows = before; throw error; }
    },
  };
  const mail = { notifyUpload: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };
  const validation = { sync: jest.fn(async () => undefined) };
  const service = new DocumentsService({ assertTransaction: jest.fn() } as never, db, audit as never, validation as never, {} as never, {} as never, mail as never);
  let sequence = 0;
  const stored = jest.spyOn(service as any, 'storeFile').mockImplementation(async () => `draft/${++sequence}.pdf`);
  const deleted = jest.spyOn(service as any, 'deleteFile').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'assertExists').mockResolvedValue(undefined);
  const drafts = () => JSON.parse(rows[0].draft_files || '[]');
  return { service, db, mail, audit, validation, stored, deleted, drafts, rows: () => rows };
}

describe('agent document drafts', () => {
  it('uploads privately without notifying Admin or marking the document Received', async () => {
    const s = setup();
    const result = await s.service.uploadFile(AGENT, 8, 4, upload);
    expect(s.rows()[0].file_path).toBeNull();
    expect(s.rows()[0].status).toBe('Pending');
    expect(s.mail.notifyUpload).not.toHaveBeenCalled();
    expect(s.validation.sync).not.toHaveBeenCalled();
    expect((result.documents as any[])[0].draft_files).toEqual([expect.objectContaining({ file_name: 'offer.pdf' })]);
    expect(JSON.stringify(result)).not.toContain('draft/1.pdf');
  });

  it('keeps drafts out of Admin payloads and received counts', async () => {
    const s = setup(); await s.service.uploadFile(AGENT, 8, 4, upload);
    const result = await s.service.payload(8, ADMIN);
    expect((result.documents as any[])[0].draft_files).toBeUndefined();
    expect((result.stats as any).received).toBe(0);
  });

  it('deletes the draft only, retaining the required checklist row', async () => {
    const s = setup(); await s.service.uploadFile(AGENT, 8, 4, upload);
    await s.service.deleteDraftFile(AGENT, 8, 4, s.drafts()[0].id);
    expect(s.rows()).toHaveLength(1);
    expect(s.rows()[0]).toMatchObject({ mandatory: true, draft_files: null, status: 'Pending', deleted_at: null });
    expect(s.deleted).toHaveBeenCalledWith('draft/1.pdf');
    expect(s.mail.notifyUpload).not.toHaveBeenCalled();
  });

  it('replaces a draft without notifying Admin', async () => {
    const s = setup(); await s.service.uploadFile(AGENT, 8, 4, upload);
    const id = s.drafts()[0].id;
    await s.service.replaceDraftFile(AGENT, 8, 4, id, { ...upload, originalname: 'correct.pdf' });
    expect(s.drafts()).toHaveLength(1);
    expect(s.drafts()[0]).toMatchObject({ file_name: 'correct.pdf', file_path: 'draft/2.pdf' });
    expect(s.drafts()[0].id).not.toBe(id);
    expect(s.deleted).toHaveBeenCalledWith('draft/1.pdf');
    expect(s.mail.notifyUpload).not.toHaveBeenCalled();
    await expect(s.service.replaceDraftFile(AGENT, 8, 4, id, upload)).rejects.toThrow('Draft changed');
  });

  it('allows scoped preview before submission', async () => {
    const s = setup(); await s.service.uploadFile(AGENT, 8, 4, upload);
    expect(await s.service.draftFileFor(AGENT, 8, 4, s.drafts()[0].id)).toMatchObject({ name: 'offer.pdf' });
  });

  it('submits once, makes the file Received and only then notifies Admin', async () => {
    const s = setup(); await s.service.uploadFile(AGENT, 8, 4, upload);
    const body = { draft_ids: [s.drafts()[0].id] };
    expect(await s.service.submitDrafts(AGENT, 8, body)).toMatchObject({ submitted_count: 1 });
    expect(s.rows()[0]).toMatchObject({ status: 'Received', validation: 'Pending', file_path: 'draft/1.pdf', draft_files: null });
    expect(s.mail.notifyUpload).toHaveBeenCalledTimes(1);
    await expect(s.service.submitDrafts(AGENT, 8, body)).rejects.toThrow('already submitted');
    expect(s.mail.notifyUpload).toHaveBeenCalledTimes(1);
  });

  it('preserves the previously submitted file when a new version is submitted', async () => {
    const s = setup({ file_path: 'original.pdf', file_name: 'original.pdf', status: 'Received' });
    await s.service.uploadFile(AGENT, 8, 4, upload);
    await s.service.submitDrafts(AGENT, 8, { draft_ids: [s.drafts()[0].id] });
    expect(s.rows()[0].file_path).toBe('original.pdf');
    expect(s.rows()[1]).toMatchObject({ file_path: 'draft/1.pdf', mandatory: false });
    expect(s.deleted).not.toHaveBeenCalled();
  });

  it('deleting a replacement draft leaves the submitted file intact', async () => {
    const s = setup({ file_path: 'original.pdf', status: 'Received' });
    await s.service.uploadFile(AGENT, 8, 4, upload);
    await s.service.deleteDraftFile(AGENT, 8, 4, s.drafts()[0].id);
    expect(s.rows()[0]).toMatchObject({ file_path: 'original.pdf', status: 'Received' });
    expect(s.deleted).not.toHaveBeenCalledWith('original.pdf');
  });

  it('protects submitted files from the old delete-file endpoint', async () => {
    const s = setup();
    await expect(s.service.deleteDocFile(AGENT, 8, 4, 0)).rejects.toThrow('Submitted files cannot be deleted');
    expect(s.deleted).not.toHaveBeenCalled();
  });

  it.each(['view', 'delete', 'submit', 'upload'])('denies %s for another agent’s transaction', async (operation) => {
    const s = setup(); s.db.transactions.findFirst.mockResolvedValue({ id: 8, agent_user_id: 99, agent: 'Other Agent' });
    const action = operation === 'view' ? s.service.draftFileFor(AGENT, 8, 4, 'x')
      : operation === 'delete' ? s.service.deleteDraftFile(AGENT, 8, 4, 'x')
      : operation === 'submit' ? s.service.submitDrafts(AGENT, 8, { draft_ids: [] })
      : s.service.uploadFile(AGENT, 8, 4, upload);
    await expect(action).rejects.toThrow('You do not have access');
  });

  it('does not allow an Admin or anonymous caller to access agent drafts', async () => {
    const s = setup();
    await expect(s.service.draftFileFor(ADMIN, 8, 4, 'x')).rejects.toThrow('agent workflow');
    await expect(s.service.submitDrafts(null, 8, { draft_ids: [] })).rejects.toThrow('Only agents');
  });

  it('refuses a stale submission without touching the newer draft', async () => {
    const s = setup(); await s.service.uploadFile(AGENT, 8, 4, upload);
    const old = s.drafts()[0].id;
    await s.service.uploadFile(AGENT, 8, 4, { ...upload, originalname: 'new.pdf' });
    await expect(s.service.submitDrafts(AGENT, 8, { draft_ids: [old] })).rejects.toThrow('Some drafts changed');
    expect(s.drafts()[0].file_name).toBe('new.pdf');
    expect(s.mail.notifyUpload).not.toHaveBeenCalled();
  });

  it('rolls back submission when another writer changes the document', async () => {
    const s = setup(); await s.service.uploadFile(AGENT, 8, 4, upload);
    s.db.documents.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(s.service.submitDrafts(AGENT, 8, { draft_ids: [s.drafts()[0].id] })).rejects.toThrow('changed during submission');
    expect(s.rows()[0].file_path).toBeNull();
    expect(s.drafts()).toHaveLength(1);
    expect(s.mail.notifyUpload).not.toHaveBeenCalled();
  });

  it('does not allow submission after Admin marks the document Valid', async () => {
    const s = setup(); await s.service.uploadFile(AGENT, 8, 4, upload);
    s.rows()[0].validation = 'Valid';
    await expect(s.service.submitDrafts(AGENT, 8, { draft_ids: [s.drafts()[0].id] })).rejects.toThrow('only a Super Admin');
    expect(s.mail.notifyUpload).not.toHaveBeenCalled();
  });

  it('supports multi-file drafts, individual removal, and partial submission', async () => {
    const s = setup({ title: 'Deposit Slip' });
    await s.service.uploadDocFile(AGENT, 8, 4, upload, null);
    await s.service.uploadDocFile(AGENT, 8, 4, { ...upload, originalname: 'second.pdf' }, null);
    const [first, second] = s.drafts();
    await s.service.submitDrafts(AGENT, 8, { draft_ids: [first.id] });
    expect(JSON.parse(s.rows()[0].files!)).toHaveLength(1);
    expect(s.drafts()[0].id).toBe(second.id);
    await s.service.deleteDraftFile(AGENT, 8, 4, second.id);
    expect(JSON.parse(s.rows()[0].files!)).toHaveLength(1);
    expect(s.mail.notifyUpload).toHaveBeenCalledTimes(1);
  });

  it('replaces per-client drafts while preserving submitted per-client versions', async () => {
    const s = setup({ title: 'Photo ID', files: JSON.stringify([{ client_name: 'Alex', file_name: 'old.pdf', file_path: 'old.pdf' }]) });
    await s.service.uploadDocFile(AGENT, 8, 4, upload, 'Alex');
    await s.service.uploadDocFile(AGENT, 8, 4, { ...upload, originalname: 'correct.pdf' }, 'Alex');
    expect(s.drafts()).toHaveLength(1);
    await s.service.submitDrafts(AGENT, 8, { draft_ids: [s.drafts()[0].id] });
    expect(JSON.parse(s.rows()[0].files!)).toHaveLength(2);
    expect(s.rows()[0].status).toBe('Received');
    expect(s.deleted).not.toHaveBeenCalledWith('old.pdf');
  });

  it('does not submit anything on an empty Submit request', async () => {
    const s = setup(); expect(await s.service.submitDrafts(AGENT, 8, { draft_ids: [] })).toMatchObject({ submitted_count: 0 });
    expect(s.mail.notifyUpload).not.toHaveBeenCalled();
  });

  it('leaves office uploads on the existing immediate-upload workflow', async () => {
    const s = setup(); await s.service.uploadFile(ADMIN, 8, 4, upload);
    expect(s.rows()[0]).toMatchObject({ status: 'Received', file_path: 'draft/1.pdf', draft_files: null });
    expect(s.mail.notifyUpload).not.toHaveBeenCalled();
  });
});
