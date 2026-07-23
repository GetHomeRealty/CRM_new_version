/**
 * The automatic delivery status, end to end.
 *
 * Runs against a second API instance started with placeholder Twilio credentials, so the signed
 * path can be exercised without touching the real service. Nothing here calls Twilio: only the
 * INBOUND direction is tested — the callbacks Twilio would make to us — which is exactly the part
 * that turns a message green on its own.
 *
 * Started by verify-sms-callback.ps1, which sets TWILIO_* and PORT and tears the instance down.
 */
const { createHmac } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const PORT = process.env.SMS_TEST_PORT || '8099';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const head = (t) => console.log(`\n--- ${t} ---`);

const sign = (url, params) =>
  createHmac('sha1', TOKEN)
    .update(Buffer.from(Object.keys(params).sort().reduce((a, k) => a + k + params[k], url), 'utf8'))
    .digest('base64');

const hook = (route, params, signature) => fetch(BASE + route, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature ?? sign(BASE + route, params) },
  body: new URLSearchParams(params).toString(),
});

const prisma = new PrismaClient();

(async () => {
  const lead = await prisma.leads.findFirst({ where: { deleted_at: null }, select: { id: true, name: true, phone: true } });
  if (!lead) { console.error('no lead to test against'); process.exitCode = 1; return; }

  const SID = 'SMverify0000000000000000000000test';
  await prisma.lead_messages.deleteMany({ where: { provider_sid: SID } });
  const msg = await prisma.lead_messages.create({
    data: {
      lead_id: lead.id, direction: 'outbound', status: 'queued', body: 'Verification — safe to delete.',
      phone: lead.phone, provider_sid: SID, sent_at: new Date(), created_by: 'verify script', created_at: new Date(),
    },
  });
  const statusOf = async () => (await prisma.lead_messages.findUnique({ where: { id: msg.id } }));

  head('a correctly signed callback moves the message along');
  ok((await hook('/api/sms/twilio/status', { MessageSid: SID, MessageStatus: 'sent' })).status === 200, 'sent is accepted');
  ok((await statusOf()).status === 'sent', 'and the message reads "sent"');

  ok((await hook('/api/sms/twilio/status', { MessageSid: SID, MessageStatus: 'delivered' })).status === 200, 'delivered is accepted');
  ok((await statusOf()).status === 'delivered', 'and the message reads "delivered" — with nobody touching it');

  head('a failure carries a reason the agent can act on');
  await hook('/api/sms/twilio/status', { MessageSid: SID, MessageStatus: 'undelivered', ErrorCode: '21614' });
  const failed = await statusOf();
  ok(failed.status === 'failed', 'undelivered lands on "failed"');
  ok(failed.error_code === '21614', 'the Twilio code is kept');
  ok(/landline/i.test(failed.error_message || ''), `and explained in words: "${failed.error_message}"`);

  head('a manual read mark is never overwritten by a callback');
  // Plain SMS has no read receipt, so "read" is something only a person can know. A late
  // "delivered" callback arriving afterwards must not undo it.
  await prisma.lead_messages.update({ where: { id: msg.id }, data: { status: 'read' } });
  await hook('/api/sms/twilio/status', { MessageSid: SID, MessageStatus: 'delivered' });
  ok((await statusOf()).status === 'read', 'a later "delivered" leaves the read mark alone');
  await hook('/api/sms/twilio/status', { MessageSid: SID, MessageStatus: 'failed', ErrorCode: '30005' });
  ok((await statusOf()).status === 'failed', 'but a failure still gets through — that one matters more');

  head('forged and unknown callbacks');
  ok((await hook('/api/sms/twilio/status', { MessageSid: SID, MessageStatus: 'delivered' }, 'Zm9yZ2Vk')).status === 403,
    'a forged signature is rejected even though the credentials are present');
  ok((await hook('/api/sms/twilio/status', { MessageSid: 'SMunknown', MessageStatus: 'delivered' })).status === 200,
    'a callback for a message we do not own is acknowledged, not an error');
  ok((await hook('/api/sms/twilio/status', { MessageSid: SID, MessageStatus: 'invented' })).status === 200,
    'an unrecognised status is ignored');
  ok((await statusOf()).status === 'failed', 'and leaves the message as it was');

  head('an inbound reply is logged against the right lead');
  const beforeCount = await prisma.lead_messages.count({ where: { lead_id: lead.id, direction: 'inbound' } });
  const REPLY_SID = 'SMverify0000000000000000000reply';
  await prisma.lead_messages.deleteMany({ where: { provider_sid: REPLY_SID } });
  const from = lead.phone || '+10000000000';
  const res = await hook('/api/sms/twilio/inbound', { From: from, Body: 'Verification reply.', MessageSid: REPLY_SID });
  ok(res.status === 200, 'the inbound webhook accepts a signed reply');
  const after = await prisma.lead_messages.count({ where: { lead_id: lead.id, direction: 'inbound' } });
  if (lead.phone) {
    ok(after === beforeCount + 1, 'the reply is logged on the lead that owns the number');
    const reply = await prisma.lead_messages.findUnique({ where: { provider_sid: REPLY_SID } });
    ok(reply.status === null, 'a received message carries no delivery status');
    ok(reply.created_by === 'SMS gateway', 'and is attributed to the gateway, not to a user');
    // Twilio retries anything it thinks failed; the same reply must not appear twice.
    await hook('/api/sms/twilio/inbound', { From: from, Body: 'Verification reply.', MessageSid: REPLY_SID });
    ok(await prisma.lead_messages.count({ where: { lead_id: lead.id, direction: 'inbound' } }) === after,
      'a retried delivery does not log it a second time');
  } else {
    console.log('  NOTE  the test lead has no phone number, so the matching checks are skipped.');
  }
  const unmatched = await prisma.lead_messages.count();
  await hook('/api/sms/twilio/inbound', { From: '+19995550000', Body: 'nobody', MessageSid: 'SMverifyNoMatch' });
  ok(await prisma.lead_messages.count() === unmatched, 'a reply from an unknown number creates nothing at all');

  head('cleanup');
  const removed = await prisma.lead_messages.deleteMany({ where: { provider_sid: { in: [SID, REPLY_SID] } } });
  ok(removed.count >= 1, `${removed.count} verification row(s) deleted`);
  ok((await prisma.lead_messages.count({ where: { created_by: { in: ['verify script', 'SMS gateway'] } } })) === 0,
    'no verification message is left behind');

  console.log(fail === 0 ? `\nALL ${pass} PASS ✅` : `\n${pass} passed, ${fail} FAILED ❌`);
  process.exitCode = fail === 0 ? 0 : 1;
  await prisma.$disconnect();
})();
