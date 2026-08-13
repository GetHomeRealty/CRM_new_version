import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CampaignTemplatesService } from './campaign-templates.service';
import { CampaignAudienceService } from './campaign-audience.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * PRIORITY 2 — ATTACHMENT SECURITY.
 *
 * THE INBOX HAS NO ATTACHMENTS. `inbound_emails` has no attachment column, no route serves one, and
 * `imap-sync.service.ts` never references them — the parser's attachments are discarded on the way
 * in. So "can Agent A download Agent B's inbox attachment" has no surface to test, and saying so is
 * the honest answer rather than writing tests that pass because nothing exists.
 *
 * The same questions land instead on the surfaces that DO store files. This file covers campaign
 * template attachments, which is the one that matters most: templates were made owner-private this
 * session on an explicit business decision — *a Super Admin must not see or edit an agent's custom
 * campaign templates* — and the attachment routes were not part of that change.
 *
 * `get`, `update` and `remove` on a template all go through `visibleWhere(user)` and
 * `assertEditable`. `getAttachment`, `addAttachment` and `removeAttachment` take no `user` argument
 * at all, and the controller does not pass one.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const svc = (tx: PrismaService) => new CampaignTemplatesService(tx, new CampaignAudienceService(tx));
const asUser = (role: string, id: number, name: string) => ({ id, name, role } as unknown as AuthUserRecord);

async function agent(tx: PrismaService, label: string) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: {
      name: `ZZ ${label} ${t}`, email: `zz-${label}-${t}@probe.test`, role: 'agent', status: 'Active',
      password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true, name: true },
  });
}

/** A private template owned by `ownerId`, carrying one attachment with recognisable contents. */
async function templateWithAttachment(tx: PrismaService, ownerId: number | null) {
  const now = new Date();
  const t = tag();
  const secret = `ZZ-SECRET-PAYLOAD-${t}`;
  const template = await tx.campaign_templates.create({
    data: {
      name: `ZZ tmpl ${t}`, subject: 'S', content: '<p>C</p>', category: 'general',
      user_id: ownerId, created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  const attachment = await tx.campaign_template_attachments.create({
    data: {
      template_id: template.id, filename: `private-${t}.txt`, content_type: 'text/plain',
      size: secret.length, data: Buffer.from(secret), created_at: now,
    },
    select: { id: true },
  });
  return { templateId: template.id, attachmentId: attachment.id, secret };
}

describe('an agent\'s template attachment is as private as the template', () => {
  /*
   * The template itself is already unreachable to these callers — `get` answers "Template not
   * found." for every one of them, proven by `e2e/tests/template-ownership.spec.ts`. The file the
   * template carries must not be the way around that.
   */
  it.each(['agent', 'crm', 'manager', 'admin'])('%s cannot download somebody else\'s attachment', async (role) => {
    await inRollback(async (tx) => {
      const owner = await agent(tx, 'owner');
      const intruder = await agent(tx, 'intruder');
      const { templateId, attachmentId } = await templateWithAttachment(tx, owner.id);

      await expect(
        svc(tx).getAttachment(templateId, attachmentId, asUser(role, intruder.id, intruder.name)),
      ).rejects.toThrow(/not found/i);
    });
  });

  it('a Super Admin cannot either — the decision the module already records for the template', async () => {
    await inRollback(async (tx) => {
      const owner = await agent(tx, 'owner');
      const sa = await agent(tx, 'sa');
      const { templateId, attachmentId } = await templateWithAttachment(tx, owner.id);

      await expect(
        svc(tx).getAttachment(templateId, attachmentId, asUser('admin', sa.id, sa.name)),
      ).rejects.toThrow(/not found/i);
    });
  });

  it('the bytes never leave — the refusal is not a header-only one', async () => {
    // The controller streams `file.data` straight to the response, so anything the service returns
    // has already left the building. The check has to be here, not there.
    await inRollback(async (tx) => {
      const owner = await agent(tx, 'owner');
      const intruder = await agent(tx, 'intruder');
      const { templateId, attachmentId, secret } = await templateWithAttachment(tx, owner.id);

      const got = await svc(tx)
        .getAttachment(templateId, attachmentId, asUser('agent', intruder.id, intruder.name))
        .catch(() => null);
      expect(got).toBeNull();
      // And the file is still intact for its owner.
      const mine = await svc(tx).getAttachment(templateId, attachmentId, asUser('agent', owner.id, owner.name));
      expect(mine.data.toString()).toBe(secret);
    });
  });

  it('the owner CAN download their own', async () => {
    // The guard rail: every test above would also pass if downloads were simply broken.
    await inRollback(async (tx) => {
      const owner = await agent(tx, 'owner');
      const { templateId, attachmentId, secret } = await templateWithAttachment(tx, owner.id);
      const file = await svc(tx).getAttachment(templateId, attachmentId, asUser('agent', owner.id, owner.name));
      expect(file.data.toString()).toBe(secret);
    });
  });

  it('a BUILT-IN template\'s attachment stays downloadable by everyone', async () => {
    /*
     * `user_id: null` is one of the six the application ships with. Everybody starts from those, so
     * locking their attachments down would break the shared set — the same split `visibleWhere`
     * already draws for the template itself.
     */
    await inRollback(async (tx) => {
      const anyone = await agent(tx, 'anyone');
      const { templateId, attachmentId, secret } = await templateWithAttachment(tx, null);
      const file = await svc(tx).getAttachment(templateId, attachmentId, asUser('agent', anyone.id, anyone.name));
      expect(file.data.toString()).toBe(secret);
    });
  });

  it('an attachment id from a DIFFERENT template is refused even for your own template', async () => {
    // The pairing check that was already there — `{ id: attachmentId, template_id: templateId }` —
    // must survive the ownership one, or a caller could name their own template and somebody else's
    // attachment id.
    await inRollback(async (tx) => {
      const owner = await agent(tx, 'owner');
      const other = await agent(tx, 'other');
      const mine = await templateWithAttachment(tx, owner.id);
      const theirs = await templateWithAttachment(tx, other.id);

      await expect(
        svc(tx).getAttachment(mine.templateId, theirs.attachmentId, asUser('agent', owner.id, owner.name)),
      ).rejects.toThrow(/not found/i);
    });
  });

  it.each([0, -1, 2_000_000_000])('a guessed attachment id (%s) is refused, not returned', async (id) => {
    await inRollback(async (tx) => {
      const owner = await agent(tx, 'owner');
      const { templateId } = await templateWithAttachment(tx, owner.id);
      await expect(
        svc(tx).getAttachment(templateId, id, asUser('agent', owner.id, owner.name)),
      ).rejects.toThrow(/not found/i);
    });
  });
});

describe('nor can somebody else add to or remove from it', () => {
  /*
   * The write side matters more than the read side, and it was equally unguarded. An attachment
   * added to a template is sent with every campaign that uses it — so this is not "edit somebody's
   * draft", it is "post a file to the brokerage's clients over that agent's name".
   */
  it('another agent cannot ADD an attachment to a template that is not theirs', async () => {
    await inRollback(async (tx) => {
      const owner = await agent(tx, 'owner');
      const intruder = await agent(tx, 'intruder');
      const { templateId } = await templateWithAttachment(tx, owner.id);

      await expect(svc(tx).addAttachment(templateId, {
        filename: 'planted.txt', content_type: 'text/plain',
        data: Buffer.from('ZZ-PLANTED').toString('base64'),
      }, asUser('agent', intruder.id, intruder.name))).rejects.toThrow();

      const count = await tx.campaign_template_attachments.count({ where: { template_id: templateId } });
      // Nothing may have been written: the original attachment, and only that.
      expect(count).toBe(1);
    });
  });

  it('a Super Admin cannot add one either', async () => {
    await inRollback(async (tx) => {
      const owner = await agent(tx, 'owner');
      const sa = await agent(tx, 'sa');
      const { templateId } = await templateWithAttachment(tx, owner.id);

      await expect(svc(tx).addAttachment(templateId, {
        filename: 'planted.txt', content_type: 'text/plain',
        data: Buffer.from('ZZ-PLANTED').toString('base64'),
      }, asUser('admin', sa.id, sa.name))).rejects.toThrow();
    });
  });

  it('another agent cannot REMOVE one', async () => {
    await inRollback(async (tx) => {
      const owner = await agent(tx, 'owner');
      const intruder = await agent(tx, 'intruder');
      const { templateId, attachmentId } = await templateWithAttachment(tx, owner.id);

      await expect(
        svc(tx).removeAttachment(templateId, attachmentId, asUser('agent', intruder.id, intruder.name)),
      ).rejects.toThrow();

      expect(await tx.campaign_template_attachments.count({ where: { id: attachmentId } })).toBe(1);
    });
  });

  it('the owner CAN add and remove their own', async () => {
    await inRollback(async (tx) => {
      const owner = await agent(tx, 'owner');
      const me = asUser('agent', owner.id, owner.name);
      const { templateId, attachmentId } = await templateWithAttachment(tx, owner.id);

      await svc(tx).addAttachment(templateId, {
        filename: 'mine.txt', content_type: 'text/plain',
        data: Buffer.from('ZZ-MINE').toString('base64'),
      }, me);
      expect(await tx.campaign_template_attachments.count({ where: { template_id: templateId } })).toBe(2);

      await svc(tx).removeAttachment(templateId, attachmentId, me);
      expect(await tx.campaign_template_attachments.count({ where: { id: attachmentId } })).toBe(0);
    });
  });

  it('an agent cannot add to a BUILT-IN template — one agent\'s file would ride on everybody\'s sends', async () => {
    await inRollback(async (tx) => {
      const anyone = await agent(tx, 'anyone');
      const { templateId } = await templateWithAttachment(tx, null);

      await expect(svc(tx).addAttachment(templateId, {
        filename: 'planted.txt', content_type: 'text/plain',
        data: Buffer.from('ZZ-PLANTED').toString('base64'),
      }, asUser('agent', anyone.id, anyone.name))).rejects.toThrow(/built-in/i);
    });
  });
});
