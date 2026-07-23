/**
 * Communication section on the lead detail: the SMS conversation store.
 *
 * The "Make Call" and "Send SMS" buttons hand off to the device via `tel:`/`sms:` links, which a
 * script cannot exercise. What is verifiable — and what the history depends on — is the message
 * store: it round-trips, it validates, it is scoped to the lead, and it appears on the detail
 * payload. Nothing here sends anything: there is no SMS gateway in this app.
 */
const fs = require('fs');
const path = require('path');

const ADMIN_LOGIN = process.env.TD_ADMIN_LOGIN || 'info@gethomerealty.ca';
const BASE = 'http://127.0.0.1:8000';
const H = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
const CLIENT = path.join(process.cwd(), '..', 'client', 'src');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const head = (t) => console.log(`\n--- ${t} ---`);
const read = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

const jar = {};
const take = (r) => {
  for (const c of (r.headers.getSetCookie?.() || [])) {
    const nv = c.split(';')[0], i = nv.indexOf('=');
    if (i > 0) jar[nv.slice(0, i)] = nv.slice(i + 1);
  }
  return r;
};
const ch = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const X = () => decodeURIComponent(jar['XSRF-TOKEN'] || '');
const get = (p) => fetch(BASE + p, { headers: { ...H, Cookie: ch() } });
const send = (m, p, b) => fetch(BASE + p, {
  method: m,
  headers: { ...H, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': X(), Cookie: ch() },
  body: b === undefined ? undefined : JSON.stringify(b),
});

(async () => {
  take(await fetch(BASE + '/sanctum/csrf-cookie', { headers: H }));
  const li = take(await send('POST', '/api/login', { username: ADMIN_LOGIN, password: 'Admin@123' }));
  if (li.status !== 200) { console.error('login failed', li.status); process.exitCode = 1; return; }

  const list = await (await get('/api/leads')).json();
  const lead = list.data[0];
  if (!lead) { console.error('no leads to test against'); process.exitCode = 1; return; }
  console.log(`  using lead #${lead.id} (${lead.name})`);

  head('the conversation starts empty and is part of the detail payload');
  const before = await (await get(`/api/leads/${lead.id}`)).json();
  ok(Array.isArray(before.messages), 'the lead detail carries a messages array');
  const startCount = before.messages.length;

  head('recording a message');
  const outRes = await send('POST', `/api/leads/${lead.id}/messages`, {
    direction: 'outbound', body: 'Verification message — safe to delete.', phone: lead.phone || null,
  });
  ok(outRes.status === 201, 'an outbound message is accepted');
  const out = await outRes.json();
  ok(out.direction === 'outbound' && out.body.startsWith('Verification'), 'it comes back with its direction and text');
  ok(typeof out.sent_at === 'string' && !Number.isNaN(Date.parse(out.sent_at)), 'and a real timestamp');
  ok(out.created_by, `attributed to the signed-in user (${out.created_by})`);

  const inRes = await send('POST', `/api/leads/${lead.id}/messages`, { direction: 'inbound', body: 'Verification reply.' });
  ok(inRes.status === 201, 'an inbound reply is accepted');
  const inbound = await inRes.json();

  head('delivery status on an outbound message');
  ok(out.status === 'sent', 'a new outbound message starts as "sent"');
  ok(inbound.status === null, 'a received message has no status — it already arrived');

  const marked = await send('PUT', `/api/leads/${lead.id}/messages/${out.id}`, { status: 'read' });
  ok(marked.status === 200 && (await marked.json()).status === 'read', 'it can be marked read');
  const failed = await send('PUT', `/api/leads/${lead.id}/messages/${out.id}`, { status: 'failed' });
  ok(failed.status === 200 && (await failed.json()).status === 'failed', 'and failed');
  // 'delivered' and 'queued' became valid when the Twilio gateway landed — they are what a
  // provider reports. Anything outside that vocabulary is still refused.
  ok((await send('PUT', `/api/leads/${lead.id}/messages/${out.id}`, { status: 'seen-by-lead' })).status === 400,
    'a status outside the vocabulary is rejected rather than stored');
  ok((await send('PUT', `/api/leads/${lead.id}/messages/${out.id}`, { status: 'delivered' })).status === 200,
    'but a real provider status is accepted');
  await send('PUT', `/api/leads/${lead.id}/messages/${out.id}`, { status: 'failed' });
  ok((await send('PUT', `/api/leads/${lead.id}/messages/${inbound.id}`, { status: 'read' })).status === 400,
    'a received message cannot be given a delivery status');
  ok((await send('PUT', `/api/leads/${lead.id}/messages/99999999`, { status: 'read' })).status === 404,
    'a missing message is a 404');
  ok((await send('POST', `/api/leads/${lead.id}/messages`, { body: 'x', status: 'nonsense' })).status === 400,
    'nor can an invalid status be smuggled in at creation');

  const detailStatus = await (await get(`/api/leads/${lead.id}`)).json();
  ok(detailStatus.messages.find((m) => m.id === out.id).status === 'failed', 'the status rides on the lead detail');
  // Restore it so the cleanup assertions below still describe a plain sent message.
  await send('PUT', `/api/leads/${lead.id}/messages/${out.id}`, { status: 'sent' });

  head('validation');
  ok((await send('POST', `/api/leads/${lead.id}/messages`, { body: '   ' })).status === 400, 'an empty message is rejected');
  ok((await send('POST', `/api/leads/${lead.id}/messages`, { body: 'x', direction: 'sideways' })).status === 400,
    'an unrecognised direction is rejected');
  ok((await send('POST', `/api/leads/${lead.id}/messages`, { body: 'x'.repeat(2001) })).status === 400,
    'an over-long message is rejected');
  ok((await send('POST', '/api/leads/99999999/messages', { body: 'x' })).status === 404, 'a missing lead is a 404');

  head('the thread reads oldest-first and is scoped to its lead');
  const after = await (await get(`/api/leads/${lead.id}`)).json();
  ok(after.messages.length === startCount + 2, `${after.messages.length - startCount} messages were added`);
  const times = after.messages.map((m) => Date.parse(m.sent_at));
  ok(times.every((t, i) => i === 0 || t >= times[i - 1]), 'they come back in conversation order');
  const other = list.data.find((l) => l.id !== lead.id);
  if (other) {
    const otherDetail = await (await get(`/api/leads/${other.id}`)).json();
    ok(!otherDetail.messages.some((m) => m.id === out.id), 'another lead does not see this conversation');
  }
  ok((await send('DELETE', `/api/leads/${lead.id}/messages/99999999`)).status === 404, 'deleting a missing message is a 404');

  head('the deal core is untouched');
  ok((await get('/api/transactions')).status === 200, 'transactions still respond');
  ok((await get('/api/invoices')).status === 200, 'invoices still respond');
  ok((await get('/api/dashboard/commissions')).status === 200, 'the dashboard still responds');

  head('frontend wiring');
  const page = read('desk/LeadDetailPage.tsx');
  ok(page.includes('function CommunicationPanel'), 'the Communication panel exists');
  for (const l of ['Communication', 'Make Call', 'Send SMS', 'View Call History', 'SMS Conversation', 'No SMS messages yet.']) {
    ok(page.includes(l), `it renders "${l}"`);
  }
  ok(page.includes('`tel:${number}`'), 'Make Call opens the device dialler');
  ok(page.includes('`sms:${number}'), 'Send SMS opens the device messaging app');
  ok(!/twilio/i.test(page), 'no telephony provider is implied — there is none');
  for (const l of ['Sent', 'Read', 'Failed to send']) {
    ok(page.includes(`'${l}'`), `the thread can show "${l}"`);
  }
  ok(page.includes('Statuses are set by hand'), 'and says plainly that nothing sets them automatically');

  head('showings: complete or cancel, no reopen');
  const showing = await (await send('POST', `/api/leads/${lead.id}/showings`, {
    showing_date: '2020-01-02', time: '10:00', property: 'Verification showing — safe to delete',
  })).json();
  ok(showing.status === 'scheduled', 'a new showing starts scheduled');
  ok((await send('PUT', `/api/leads/${lead.id}/showings/${showing.id}`, { status: 'cancelled' })).status === 200,
    'it can be cancelled');
  ok((await send('PUT', `/api/leads/${lead.id}/showings/${showing.id}`, { status: 'completed' })).status === 200,
    'and completed');
  ok((await send('PUT', `/api/leads/${lead.id}/showings/${showing.id}`, { status: 'reopened' })).status === 400,
    'an invented status is rejected');
  ok((await send('DELETE', `/api/leads/${lead.id}/showings/${showing.id}`)).status === 200, 'the test showing is deleted');

  const showingsBlock = page.slice(page.indexOf('function ShowingsPanel'), page.indexOf('// ----------------------------------------------------------- communication'));
  // "Reopen" was removed from Showings on request — assert it stays gone rather than dropping
  // the check, and that Cancel took its place.
  // Match a rendered label, not the word: the comment above the buttons says why Reopen went.
  ok(!/Reopen\s*<\/button>/.test(showingsBlock) && !/'Reopen'/.test(showingsBlock),
    'the Showings panel offers no Reopen button');
  ok(/>\s*Cancel\s*</.test(showingsBlock), 'it offers Cancel instead');
  ok(showingsBlock.includes("{ status: 'cancelled' }"), 'which sets the cancelled status');
  ok(showingsBlock.includes("{ status: 'completed' }"), 'Complete is still there');
  ok(/>\s*Reschedule\s*</.test(showingsBlock) && showingsBlock.includes("{ status: 'scheduled' }"),
    'and Reschedule puts a completed or cancelled showing back, so a mis-click is undoable');
  ok(showingsBlock.includes("s.status !== 'completed' &&") && showingsBlock.includes("s.status !== 'cancelled' &&")
    && showingsBlock.includes("s.status !== 'scheduled' &&"),
    'no button is offered for the state the showing is already in');

  head('call recordings');
  const call = await (await send('POST', `/api/leads/${lead.id}/calls`, { outcome: 'connected', notes: 'Verification call' })).json();
  ok(call.id > 0, 'a call was logged to attach a recording to');
  ok(call.recording === undefined || call.recording === null, 'it starts with no recording');

  // A 1-second silent WAV: real audio, small enough to keep in the script.
  const wav = Buffer.concat([
    Buffer.from('RIFF'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(36 + 8000); return b; })(),
    Buffer.from('WAVEfmt '), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(16); return b; })(),
    (() => { const b = Buffer.alloc(16); b.writeUInt16LE(1, 0); b.writeUInt16LE(1, 2); b.writeUInt32LE(8000, 4); b.writeUInt32LE(8000, 8); b.writeUInt16LE(1, 12); b.writeUInt16LE(8, 14); return b; })(),
    Buffer.from('data'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(8000); return b; })(),
    Buffer.alloc(8000, 128),
  ]);
  const up = await send('POST', `/api/leads/${lead.id}/calls/${call.id}/recording`, {
    filename: 'verification.wav', content_type: 'audio/wav', data: wav.toString('base64'),
  });
  ok(up.status === 201, 'an audio file can be attached');
  const rec = await up.json();
  ok(rec.size === wav.length, `it is stored whole (${rec.size} bytes)`);
  ok(rec.content_type === 'audio/wav' && rec.filename === 'verification.wav', 'with its type and name');

  head('the recording is playable, and only audio is accepted');
  const play = await get(`/api/leads/${lead.id}/calls/${call.id}/recording`);
  ok(play.status === 200, 'the stream endpoint responds');
  ok(play.headers.get('content-type') === 'audio/wav', 'it serves the stored audio type');
  ok((play.headers.get('content-disposition') || '').startsWith('inline'),
    'inline, so the browser plays it in place rather than downloading');
  ok(play.headers.get('x-content-type-options') === 'nosniff',
    'with nosniff, so the browser cannot second-guess the type');
  ok(Buffer.from(await play.arrayBuffer()).equals(wav), 'and the bytes come back byte-for-byte identical');

  // Serving an upload inline from our own origin is only safe because the type is allowlisted:
  // an HTML or SVG file would otherwise run script in the signed-in session.
  for (const bad of ['text/html', 'image/svg+xml', 'application/javascript', 'application/pdf']) {
    ok((await send('POST', `/api/leads/${lead.id}/calls/${call.id}/recording`, {
      filename: 'x', content_type: bad, data: Buffer.from('<script>alert(1)</script>').toString('base64'),
    })).status === 400, `a ${bad} upload is refused`);
  }
  ok((await send('POST', `/api/leads/${lead.id}/calls/${call.id}/recording`, {
    filename: 'x.wav', content_type: 'audio/wav', data: '',
  })).status === 400, 'an empty file is refused');
  ok((await send('POST', `/api/leads/${lead.id}/calls/99999999/recording`, {
    filename: 'x.wav', content_type: 'audio/wav', data: wav.toString('base64'),
  })).status === 404, 'a missing call is a 404');

  head('the recording rides on the lead detail as metadata only');
  const withRec = await (await get(`/api/leads/${lead.id}`)).json();
  const loggedCall = withRec.calls.find((c) => c.id === call.id);
  ok(loggedCall.recording && loggedCall.recording.size === wav.length, 'the call carries its recording metadata');
  ok(!('data' in loggedCall.recording), 'but not the audio itself — the blob never rides along with a lead');
  ok(withRec.calls.filter((c) => !c.recording).every((c) => c.recording === null), 'calls with no recording report null');

  // Re-uploading replaces rather than stacking up copies.
  const replaced = await send('POST', `/api/leads/${lead.id}/calls/${call.id}/recording`, {
    filename: 'second.wav', content_type: 'audio/wav', data: wav.toString('base64'),
  });
  ok(replaced.status === 201, 're-attaching is allowed');
  const afterReplace = await (await get(`/api/leads/${lead.id}`)).json();
  ok(afterReplace.calls.find((c) => c.id === call.id).recording.filename === 'second.wav',
    'and replaces the previous file rather than adding a second');

  head('the activity panels are append-only from the UI');
  // Requested: no delete option on Notes, Tasks, Showings, Call Log or the SMS conversation.
  // The endpoints still exist for administrative cleanup; they are just not reachable from there.
  for (const fn of ['deleteLeadNote', 'deleteLeadTask', 'deleteLeadShowing', 'deleteLeadCall', 'deleteLeadMessage']) {
    ok(!page.includes(fn), `the lead detail never calls ${fn}`);
  }
  ok((page.match(/>Delete<\/button>/g) || []).length === 0, 'no Delete button is rendered on any activity panel');
  ok(page.includes('deleteCallRecording'), 'a wrongly-attached recording can still be removed — it is a file, not a log entry');

  head('cleaning up the verification rows');
  ok((await send('DELETE', `/api/leads/${lead.id}/calls/${call.id}/recording`)).status === 200, 'the test recording is deleted');
  ok((await get(`/api/leads/${lead.id}/calls/${call.id}/recording`)).status === 404, 'and is gone');
  ok((await send('DELETE', `/api/leads/${lead.id}/calls/${call.id}`)).status === 200, 'the test call is deleted');

  head('nothing reloads the page after a write');
  ok(/await load\(true\)/.test(page), 'lead detail refreshes quietly after a write');
  // A modal that is mounted fresh each time it opens has nothing on screen to preserve, so its
  // own one-shot loader is correct — LeadsPage's Recently Deleted dialog is the one such case.
  const UNGUARDED_ALLOWED = { 'LeadsPage.tsx': 1, 'CalendarPage.tsx': 0, 'CampaignsPage.tsx': 0, 'CampaignTemplates.tsx': 0, 'CrmSettingsPanel.tsx': 0 };
  for (const [f, allowed] of Object.entries(UNGUARDED_ALLOWED)) {
    const src = read(`desk/${f}`);
    ok(src.includes('if (!loadedOnce.current) setLoading(true)'), `${f} only shows a loader on the first fetch`);
    const unguarded = (src.match(/(?<!current\) )setLoading\(true\)/g) || []).length;
    ok(unguarded === allowed, `${f} has ${unguarded} unguarded loader(s), the ${allowed} expected`);
  }

  head('cleaning up the verification rows');
  ok((await send('DELETE', `/api/leads/${lead.id}/messages/${out.id}`)).status === 200, 'the outbound test message is deleted');
  ok((await send('DELETE', `/api/leads/${lead.id}/messages/${inbound.id}`)).status === 200, 'the inbound test message is deleted');
  const end = await (await get(`/api/leads/${lead.id}`)).json();
  ok(end.messages.length === startCount, 'the conversation is back to exactly how it started');

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
