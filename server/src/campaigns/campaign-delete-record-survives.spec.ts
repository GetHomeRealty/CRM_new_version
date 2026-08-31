import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CampaignsService } from './campaigns.service';
import { CampaignAuditService } from './campaign-audit.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-035: deleting a campaign must not erase the record that it was sent.
 *
 * WHAT THE AUDIT FOUND. Three campaigns were deleted on the afternoon of 27 August, two of them
 * real mailings to real clients — one sent that morning to two people who both opened it. Afterwards
 * NOTHING in the CRM recorded that those mailings had happened: the campaign row was the only store,
 * campaigns never reached the email log (CRM-028), and the audit trail carried no CRM events
 * (CRM-006). The question "did we email this client, and what did we say?" had no answer.
 *
 * THE DELETE CONTROL WAS NEVER AT FAULT, and the audit said so plainly: it confirms properly and
 * its warning is accurate. What was missing was a durable record elsewhere. Both halves now exist —
 * CRM-028 writes a log row per recipient, and the deletion itself is audited — so what is left to
 * establish is the thing nobody had tested: that those records actually SURVIVE the delete.
 *
 * THAT IS NOT OBVIOUS AND IS WORTH PINNING. `campaigns.delete` cascades to `campaign_recipients`,
 * and a later migration adding a link from the log to the campaign would quietly take the log with
 * it — reintroducing this defect without anybody touching the delete path.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const BOSS = { id: 1, name: 'Akhil', role: 'admin' } as unknown as AuthUserRecord;

function svc(tx: PrismaService) {
  return new CampaignsService(
    tx, null as never, null as never, null as never, null as never,
    undefined, new CampaignAuditService(tx),
  );
}

/** A campaign that has gone out, with the log rows the send would have written. */
async function sentCampaign(tx: PrismaService, recipients: string[]) {
  const t = tag();
  const now = new Date();
  const campaign = await tx.campaigns.create({
    data: {
      name: `ZZ Sent ${t}`, subject: `ZZ subject ${t}`, content: '<p>hi</p>',
      status: 'completed', sent: recipients.length, created_by: BOSS.name, created_by_id: BOSS.id,
      sent_at: now, created_at: now, updated_at: now,
    },
  });
  for (const email of recipients) {
    await tx.campaign_recipients.create({
      // `token` is required and unique: it is the per-recipient handle in the open pixel and the
      // unsubscribe link, so every row has one whether the send used it or not.
      data: {
        campaign_id: campaign.id, email, name: 'ZZ', status: 'sent',
        token: `zz-tok-${tag()}`, created_at: now, updated_at: now,
      },
    });
    // What the send path now writes for each recipient (CRM-028).
    await tx.crm_email_log.create({
      data: {
        kind: 'campaign', recipient: email, subject: campaign.subject,
        success: true, sent_by: BOSS.name, created_at: now,
      },
    });
  }
  return campaign;
}

describe('the record of a mailing outlives the campaign', () => {
  it('keeps a row per recipient after the campaign is deleted', async () => {
    await inRollback(async (tx) => {
      const addresses = [`zz-one-${tag()}@probe.invalid`, `zz-two-${tag()}@probe.invalid`];
      const campaign = await sentCampaign(tx, addresses);

      await expect(svc(tx).remove(campaign.id, BOSS)).resolves.toEqual({ success: true });

      // The campaign and its recipients are gone, exactly as the confirmation promised.
      expect(await tx.campaigns.count({ where: { id: campaign.id } })).toBe(0);
      expect(await tx.campaign_recipients.count({ where: { campaign_id: campaign.id } })).toBe(0);

      // THE POINT: what was sent to whom is still answerable.
      const kept = await tx.crm_email_log.findMany({ where: { recipient: { in: addresses } } });
      expect(kept).toHaveLength(2);
      expect(kept.every((r) => r.subject === campaign.subject)).toBe(true);
      expect(kept.every((r) => r.kind === 'campaign')).toBe(true);
    });
  });

  it('records who deleted it, and what state it was in', async () => {
    // The audit's other complaint: "not what was sent, not who received it, NOT WHO DELETED IT."
    await inRollback(async (tx) => {
      const campaign = await sentCampaign(tx, [`zz-three-${tag()}@probe.invalid`]);
      await svc(tx).remove(campaign.id, BOSS);

      const row = await tx.audit_logs.findFirst({
        where: { action: 'Campaign deleted', new_value: { contains: campaign.name } },
        orderBy: { id: 'desc' },
      });
      expect(row).toBeTruthy();
      expect(row!.who).toBe('Akhil');
      expect(row!.details).toMatch(/completed/i);
    });
  });

  it('the surviving rows name the recipient, so a client question can be answered', async () => {
    await inRollback(async (tx) => {
      const one = `zz-client-${tag()}@probe.invalid`;
      const campaign = await sentCampaign(tx, [one]);
      await svc(tx).remove(campaign.id, BOSS);

      // "Did we email this person, and what did we say?" — asked of the address, as it would be.
      const forClient = await tx.crm_email_log.findMany({ where: { recipient: one } });
      expect(forClient).toHaveLength(1);
      expect(forClient[0].sent_by).toBe('Akhil');
      expect(forClient[0].created_at).toBeTruthy();
    });
  });
});
