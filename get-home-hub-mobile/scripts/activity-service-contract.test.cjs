// Real backend activity implementation; in-memory storage only, no network or database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function compile(file, requireStub) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../server/src/leads', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
  }).outputText, { exports, require: requireStub });
  return exports;
}
function setup() {
  const constants = compile('lead.constants.ts', () => ({}));
  const service = compile('lead-activity.service.ts', (name) => name === '@nestjs/common'
    ? { Injectable: () => (target) => target, BadRequestException: Error, NotFoundException: Error }
    : name === './lead.constants' ? constants : {});
  const task = { id: 12, lead_id: 7, title: 'Local follow-up', status: 'pending', priority: 'medium', due_date: new Date('2030-01-01'), description: 'Keep me' };
  const note = { id: 13, lead_id: 7, user_id: 1, content: 'Local note', pinned: false, created_at: new Date('2030-01-01'), created_by: 'Test' };
  const showing = { id: 15, lead_id: 7, showing_date: new Date('2030-01-01'), time: '14:30', property: 'Synthetic property', notes: 'Keep showing notes', status: 'scheduled', created_at: null };
  const accesses = [], audits = [], created = [];
  const table = (row) => ({
    findFirst: async ({ where }) => where.id === row.id && where.lead_id === row.lead_id ? { ...row } : null,
    update: async ({ data }) => Object.assign(row, data),
    create: async ({ data }) => { const record = { id: 100 + created.length, ...data }; created.push(record); return record; },
  });
  const blocked = new Proxy({}, { get: () => () => { throw new Error('Outbound communications forbidden in this test'); } });
  const access = { assertLead: async (user, id) => { accesses.push(id); if (user.id !== 1 || id !== 7) throw new Error('Forbidden'); } };
  const accessClass = compile('../core/resource-access.service.ts', (name) => name === '@nestjs/common'
    ? { Injectable: () => (target) => target, ForbiddenException: Error, NotFoundException: Error } : {});
  access.assertNoteAuthor = accessClass.ResourceAccessService.prototype.assertNoteAuthor;
  return { task, note, showing, accesses, audits, created, service: new service.LeadActivityService(access,
    { leads: { findFirst: async () => ({ id: 7, name: 'Synthetic lead' }) }, lead_tasks: table(task), lead_notes: table(note), lead_showings: table(showing) }, { record: async (...args) => audits.push(args) }, blocked, blocked, blocked, blocked) };
}
test('Actual CRM service supports mobile task transitions without overwriting other fields', async () => {
  const { service, task, accesses, audits } = setup();
  for (const status of ['completed', 'pending', 'cancelled']) {
    await service.updateTask(7, 12, { status }, { id: 1, name: 'Test' });
    assert.equal(task.status, status);
    assert.equal(task.description, 'Keep me');
  }
  assert.equal(accesses.length, 3);
  assert.equal(audits.length, 3);
  await assert.rejects(service.updateTask(7, 12, { status: 'invalid' }, { id: 1 }));
  assert.equal(task.status, 'cancelled');
});
test('Actual CRM service pins notes and refuses unauthorized or mismatched records', async () => {
  const { service, note } = setup();
  for (const pinned of [true, false]) {
    await service.updateNote(7, 13, { pinned }, { id: 1, name: 'Test' });
    assert.equal(note.pinned, pinned);
    assert.equal(note.content, 'Local note');
  }
  await assert.rejects(service.updateNote(8, 13, { pinned: true }, { id: 1 }), /Forbidden/);
  await assert.rejects(service.updateNote(7, 13, { pinned: true }, { id: 2 }), /Forbidden/);
  await assert.rejects(service.updateNote(7, 99, { pinned: true }, { id: 1 }));
  note.user_id = 99;
  await assert.rejects(service.updateNote(7, 13, { pinned: true }, { id: 1, name: 'Test' }));
  assert.equal(note.pinned, false);
});
test('Actual task creation preserves priorities, descriptions, dates and default assignment', async () => {
  const { service, created, audits } = setup();
  for (const priority of ['low', 'medium', 'high']) {
    const result = await service.addTask(7, { title: ' Follow up ', description: ' Local instructions ', due_date: '2032-02-29', priority }, { id: 1, name: 'Test' });
    assert.equal(result.title, 'Follow up');
    assert.equal(result.description, 'Local instructions');
    assert.equal(result.priority, priority);
    assert.equal(result.due_date, '2032-02-29');
    assert.equal(result.assigned_to, 1);
    assert.equal(result.status, 'pending');
  }
  assert.equal(created.length, 3);
  assert.equal(audits.length, 3);
  const blank = await service.addTask(7, { title: 'Task', description: ' ', due_date: '2030-01-01' }, { id: 1 });
  assert.equal(blank.description, null);
});
test('Actual task service rejects invalid input before storage or audit writes', async () => {
  const { service, created, audits } = setup();
  const base = { title: 'Task', due_date: '2030-01-01', priority: 'medium' };
  for (const patch of [{ title: ' ' }, { due_date: '2030-02-30' }, { priority: 'urgent' }, { status: 'unknown' }]) {
    await assert.rejects(service.addTask(7, { ...base, ...patch }, { id: 1 }));
  }
  await assert.rejects(service.addTask(7, base, { id: 2 }), /Forbidden/);
  assert.equal(created.length, 0);
  assert.equal(audits.length, 0);
});
test('Showing status transitions preserve scheduling and notes in the actual service', async () => {
  const { service, showing, audits } = setup();
  for (const status of ['completed', 'cancelled', 'scheduled']) {
    const result = await service.updateShowing(7, 15, { status }, { id: 1 });
    assert.equal(result.status, status);
    assert.equal(result.showing_date, '2030-01-01');
    assert.equal(result.time, '14:30');
    assert.equal(result.notes, 'Keep showing notes');
  }
  assert.equal(audits.length, 3);
  await assert.rejects(service.updateShowing(7, 15, { status: 'invalid' }, { id: 1 }));
  await assert.rejects(service.updateShowing(7, 999, { status: 'completed' }, { id: 1 }));
  await assert.rejects(service.updateShowing(8, 15, { status: 'completed' }, { id: 1 }), /Forbidden/);
  showing.lead_id = 99;
  await assert.rejects(service.updateShowing(7, 15, { status: 'completed' }, { id: 1 }));
  assert.equal(showing.status, 'scheduled');
  assert.equal(audits.length, 3);
});
