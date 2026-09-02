import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignTemplatesService } from './campaign-templates.service';

/**
 * ONE COMMIT, ONE CAMPAIGN — ENFORCED BY THE SERVER, NOT BY A DISABLED BUTTON.
 *
 * ================================================================================================
 * THE DEFECT THIS CLOSES, found by probing the builder in a browser during the CRM audit. Nothing
 * on the server stopped a repeated commit from creating a second campaign. The only protection was
 * `disabled={sending}` on the button, and removing that attribute produced two scheduled campaigns
 * of eighteen recipients each — same name, same template, same audience, same scheduled time.
 *
 * A duplicate campaign is not an untidy row: it is every recipient receiving the message twice.
 * And a disabled button is defeated by a network retry, a request the browser replayed, a second
 * tab, or a direct call to the API — none of which involve the button at all.
 *
 * Leads never had this exposure because `leads_owner_email_key` catches a repeat in the database.
 * Campaigns have no natural key of that kind — two campaigns with the same name, template and
 * audience a week apart are entirely legitimate — so the CLIENT names the attempt and the server
 * refuses to perform the same named attempt twice.
 * ================================================================================================
 *
 * WHAT EACH TEST IS FOR:
 *
 *   the sequential replay      the ordinary double-click, where the second request arrives after
 *                              the first has finished — answered by the up-front lookup
 *   the concurrent replay      two requests in flight at once, where both look and both find
 *                              nothing — answered only by the unique index, which is why it exists
 *   no key                     unchanged behaviour for any caller that sends none
 *   a different key            two deliberately identical campaigns must both be created
 *   another user's key         a replay must never be answered to somebody else's account
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 120_000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const uniq = () => `${Date.now()}-${++seq}`;

/** A service whose mailer records rather than sends. */
function service(tx: PrismaService, sent: string[]) {
  const audience = new CampaignAudienceService(tx);
  const mailer = {
    resolveSenderInArea: async () => ({ id: 1, from_email: 'crm@test.local' }), sendFromAccount(this: { sendDirect: (t: string) => unknown }, _a: unknown, o: { to: string[] }) { return this.sendDirect(o.to[0]); }, sendDirect: async (to: string) => { sent.push(to); return { ok: true }; },
  } as never;
  const deliverable = { check: async () => ({ ok: true }), assertSendable: async () => undefined } as never;
  return new CampaignsService(tx, audience, new CampaignTemplatesService(tx, audience), deliverable, mailer);
}

async function makeAgent(tx: PrismaService): Promise<AuthUserRecord> {
  const now = new Date();
  const u = await tx.users.create({
    data: {
      name: `Camp agent ${uniq()}`, email: `camp-${uniq()}@example.test`,
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
  });
  return { ...u, user_permissions: [] } as unknown as AuthUserRecord;
}

/** A template this agent is allowed to send, plus a lead for it to reach. */
async function scene(tx: PrismaService) {
  const user = await makeAgent(tx);
  const now = new Date();
  const template = await tx.campaign_templates.create({
    data: {
      name: `Tmpl ${uniq()}`, subject: 'Hello {{ lead_name }}', content: '<p>Hi</p>',
      // `user_id` is what `authoredWhere` filters on — the template must be this agent's own,
      // or `createAndSend` refuses it as not found.
      category: 'custom', is_active: true, user_id: user.id, created_by: user.name,
      created_at: now, updated_at: now,
    } as never,
  });
  await tx.leads.create({
    data: {
      name: `Camp lead ${uniq()}`, email: `camp-lead-${uniq()}@example.test`,
      owner_user_id: user.id, created_at: now, updated_at: now,
    } as never,
  });
  return { user, template };
}

/** The builder's payload, minus the key. Scheduled, so nothing is delivered during the test. */
const payload = (name: string, templateId: number) => ({
  name,
  template_id: templateId,
  baseUrl: 'https://example.test',
  scheduled_for: new Date(Date.now() + 3 * 86_400_000).toISOString(),
});

const countNamed = (tx: PrismaService, name: string) => tx.campaigns.count({ where: { name } });

describe('a repeated commit does not become a second campaign', () => {
  it('a sequential replay returns the original rather than creating again', async () => {
    await inRollback(async (tx) => {
      const { user, template } = await scene(tx);
      const svc = service(tx, []);
      const name = `Seq ${uniq()}`;
      const key = `key-${uniq()}`;

      const first = await svc.createAndSend({ ...payload(name, template.id), idempotency_key: key } as never, user);
      const second = await svc.createAndSend({ ...payload(name, template.id), idempotency_key: key } as never, user);

      expect(await countNamed(tx, name)).toBe(1);
      // The replay is answered with the SAME campaign, not an error: the caller asked for one
      // campaign and there is one campaign.
      expect((second as { id: number }).id).toBe((first as { id: number }).id);
    });
  });

  /**
   * THE RACE THE LOOKUP CANNOT CATCH. Both requests look, both find nothing, both proceed — which is
   * exactly what a double-click on a slow connection produces. Only the unique index can break the
   * tie, and this is the test that proves it does.
   *
   * ================================================================================================
   * NOT RUN INSIDE THE ROLLBACK WRAPPER, and the reason is the mechanism itself. In PostgreSQL a
   * unique violation ABORTS THE ENCLOSING TRANSACTION: every later statement then fails with 25P02,
   * "current transaction is aborted". So the recovery lookup — the whole point of catching P2002 —
   * cannot run inside a caller's transaction, and this test wrapped in one failed on the count
   * afterwards rather than on anything the code did.
   *
   * In production `createAndSend` is not inside an explicit transaction: `campaigns.create` is its
   * own implicit one, a collision rolls back that statement alone, and the connection is clean for
   * the lookup that follows. This test therefore uses the real client and cleans up after itself,
   * which is what `campaign-concurrency.spec.ts` does for the same reason.
   *
   * IT IS ALSO A REAL CONSTRAINT ON CALLERS: wrapping `createAndSend` in an outer transaction would
   * break the recovery. Nothing does today, and the service comment says so.
   * ================================================================================================
   */
  it('two concurrent commits with one key produce one campaign', async () => {
    const tx = prisma as unknown as PrismaService;
    const svc = service(tx, []);
    const name = `Race ${uniq()}`;
    const key = `key-${uniq()}`;
    let made: number[] = [];

    try {
      const { user, template } = await scene(tx);
      const results = await Promise.allSettled([
        svc.createAndSend({ ...payload(name, template.id), idempotency_key: key } as never, user),
        svc.createAndSend({ ...payload(name, template.id), idempotency_key: key } as never, user),
      ]);

      const rows = await prisma.campaigns.findMany({ where: { name }, select: { id: true } });
      made = rows.map((r) => r.id);

      expect(made).toHaveLength(1);
      const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ id: number }>[];
      // Neither caller should be handed an error: both are told about the one campaign.
      expect(ok).toHaveLength(2);
      expect(ok[0].value.id).toBe(ok[1].value.id);
    } finally {
      // Left `scheduled`, this row is visible to every other spec's recovery sweep — see the note in
      // `campaign-concurrency.spec.ts`. Remove it immediately rather than in `afterAll`.
      await prisma.campaign_recipients.deleteMany({ where: { campaign_id: { in: made } } });
      await prisma.campaigns.deleteMany({ where: { name } });
    }
  });

  it('a different key creates a second campaign — identical content is not the test', async () => {
    await inRollback(async (tx) => {
      const { user, template } = await scene(tx);
      const svc = service(tx, []);
      const name = `Twice ${uniq()}`;

      await svc.createAndSend({ ...payload(name, template.id), idempotency_key: `a-${uniq()}` } as never, user);
      await svc.createAndSend({ ...payload(name, template.id), idempotency_key: `b-${uniq()}` } as never, user);

      /*
       * BOTH EXIST, and that is the point of keying on the ATTEMPT rather than on the content. The
       * same newsletter to the same segment a week later is a normal thing to want, and a
       * content-based guard would refuse it — which is why that option was not taken.
       */
      expect(await countNamed(tx, name)).toBe(2);
    });
  });

  it('a caller that sends no key is not deduplicated, exactly as before', async () => {
    await inRollback(async (tx) => {
      const { user, template } = await scene(tx);
      const svc = service(tx, []);
      const name = `NoKey ${uniq()}`;

      await svc.createAndSend(payload(name, template.id) as never, user);
      await svc.createAndSend(payload(name, template.id) as never, user);

      // Two campaigns, two NULL keys — and NULLs never collide under the unique index.
      expect(await countNamed(tx, name)).toBe(2);
    });
  });

  /**
   * THE SECURITY HALF. Keys are chosen by the client, so a lookup on the key alone would hand back
   * somebody else's campaign — its name, its audience size, its recipients — to anyone who guessed
   * or observed one. Scoping the lookup to the caller is what stops a de-duplication feature
   * becoming a disclosure.
   */
  it('one person’s key cannot return another person’s campaign', async () => {
    await inRollback(async (tx) => {
      const a = await scene(tx);
      const b = await scene(tx);
      const svc = service(tx, []);
      const sharedKey = `shared-${uniq()}`;

      const mine = await svc.createAndSend(
        { ...payload(`A ${uniq()}`, a.template.id), idempotency_key: sharedKey } as never, a.user,
      ) as { id: number };

      // B replays A's key. B must get B's own new campaign, never A's.
      const theirs = await svc.createAndSend(
        { ...payload(`B ${uniq()}`, b.template.id), idempotency_key: sharedKey } as never, b.user,
      ) as { id: number };

      expect(theirs.id).not.toBe(mine.id);
      const bRow = await tx.campaigns.findUnique({ where: { id: theirs.id } });
      expect(bRow!.created_by_id).toBe(b.user.id);
    });
  });

  it('the key is stored on the campaign, so a later replay still resolves', async () => {
    await inRollback(async (tx) => {
      const { user, template } = await scene(tx);
      const svc = service(tx, []);
      const name = `Stored ${uniq()}`;
      const key = `key-${uniq()}`;

      const made = await svc.createAndSend(
        { ...payload(name, template.id), idempotency_key: key } as never, user,
      ) as { id: number };

      const row = await tx.campaigns.findUnique({ where: { id: made.id } });
      expect(row!.idempotency_key).toBe(key);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
