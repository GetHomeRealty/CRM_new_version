import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { MentionService } from './mention.service';
import { MessagesService } from './messages.service';
import type { ResourceUser } from './transaction.resource';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { NotificationPreferenceService } from '../notifications/notification-preference.service';

/**
 * Team chat mentions — the rules, before any notification is sent.
 *
 * THE RULE THIS FILE EXISTS FOR: a mention may only ever reach somebody who could already open the
 * deal. Without it, typing `@` and a name tells an outsider that a transaction exists, what property
 * it concerns and what the team is saying about it — and it would not look like a leak, it would
 * look like the feature working.
 *
 * The ids arriving from a client are a REQUEST, never a decision. Everything below is about what the
 * server does with that request.
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

const mentionsFor = (tx: PrismaService) => new MentionService(tx, new ResourceAccessService(tx));

/** Records every dispatch, so "who was told" is directly observable. */
function chatWith(tx: PrismaService) {
  const sent: Array<{ userId: number; category: string; dedupeKey?: string; link?: string }> = [];
  const dispatcher = {
    dispatch: async (req: { userId: number; category: string; dedupeKey?: string; link?: string }) => {
      sent.push(req);
      return { category: req.category, userId: req.userId, delivered: [], skipped: [], failed: [] };
    },
  };
  const messages = new MessagesService(tx, new ResourceAccessService(tx), mentionsFor(tx), dispatcher as never);
  return { messages, sent };
}

async function makeUser(tx: PrismaService, over: Record<string, unknown> = {}): Promise<{ id: number; name: string }> {
  const now = new Date();
  const t = tag();
  const row = await tx.users.create({
    data: {
      name: `ZZ Mention ${t}`, email: `zz-mention-${t}@probe.test`, username: `zzmention${t.replace(/-/g, '')}`,
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,      ...over,
    },
    select: { id: true, name: true },
  });
  return row;
}

/** A deal owned by `owner`, plus an outsider who has nothing to do with it. */
async function scene(tx: PrismaService) {
  const owner = await makeUser(tx);
  const outsider = await makeUser(tx);
  const now = new Date();
  const txn = await tx.transactions.create({
    data: {
      trade_no: `ZZ-M-${tag()}`, type: 'Sale', agent: owner.name,
      property: '12 Probe Street', created_at: now, updated_at: now,    },
    select: { id: true },
  });
  return { owner, outsider, txn };
}

const asUser = (u: { id: number; name: string }): ResourceUser => ({ id: u.id, role: 'agent', name: u.name });

// ============================================================================ resolution
describe('who a mention resolves to', () => {
  it('accepts somebody who can open the deal', async () => {
    await inRollback(async (tx) => {
      const { owner, outsider, txn } = await scene(tx);
      await tx.team_members.create({ data: { transaction_id: txn.id, name: outsider.name } });

      const result = await mentionsFor(tx).resolve(asUser(owner), txn.id, [outsider.id]);
      expect(result.allowed).toEqual([outsider.id]);
      expect(result.refused).toEqual([]);
    });
  });

  it('REFUSES somebody who cannot — the rule this feature turns on', async () => {
    /*
     * The security test. `outsider` is a real, active user who simply has nothing to do with this
     * deal. Naming them must not tell them it exists.
     */
    await inRollback(async (tx) => {
      const { owner, outsider, txn } = await scene(tx);

      const result = await mentionsFor(tx).resolve(asUser(owner), txn.id, [outsider.id]);
      expect(result.allowed).toEqual([]);
      expect(result.refused).toEqual([{ id: outsider.id, reason: 'no_access' }]);
    });
  });

  it('refuses a deactivated colleague', async () => {
    await inRollback(async (tx) => {
      const { owner, txn } = await scene(tx);
      const gone = await makeUser(tx, { status: 'Inactive' });
      await tx.team_members.create({ data: { transaction_id: txn.id, name: gone.name } });

      const result = await mentionsFor(tx).resolve(asUser(owner), txn.id, [gone.id]);
      expect(result.allowed).toEqual([]);
      expect(result.refused).toEqual([{ id: gone.id, reason: 'inactive' }]);
    });
  });

  it('refuses an id that is nobody', async () => {
    await inRollback(async (tx) => {
      const { owner, txn } = await scene(tx);
      const result = await mentionsFor(tx).resolve(asUser(owner), txn.id, [999_999_999]);
      expect(result.allowed).toEqual([]);
      expect(result.refused).toEqual([{ id: 999_999_999, reason: 'unknown' }]);
    });
  });

  it('does not notify you about your own message', async () => {
    // People write "@me" as a note to themselves; being told about something you just typed is noise.
    await inRollback(async (tx) => {
      const { owner, txn } = await scene(tx);
      const result = await mentionsFor(tx).resolve(asUser(owner), txn.id, [owner.id]);
      expect(result.allowed).toEqual([]);
      expect(result.refused).toEqual([{ id: owner.id, reason: 'self' }]);
    });
  });

  it('counts one person once, however many times they are named', async () => {
    await inRollback(async (tx) => {
      const { owner, outsider, txn } = await scene(tx);
      await tx.team_members.create({ data: { transaction_id: txn.id, name: outsider.name } });

      const result = await mentionsFor(tx).resolve(asUser(owner), txn.id, [outsider.id, outsider.id, outsider.id]);
      expect(result.allowed).toEqual([outsider.id]);
    });
  });

  it('accepts several people at once, and sorts the allowed from the refused', async () => {
    await inRollback(async (tx) => {
      const { owner, outsider, txn } = await scene(tx);
      const colleague = await makeUser(tx);
      await tx.team_members.create({ data: { transaction_id: txn.id, name: colleague.name } });

      const result = await mentionsFor(tx).resolve(asUser(owner), txn.id, [colleague.id, outsider.id, owner.id]);
      expect(result.allowed).toEqual([colleague.id]);
      expect(result.refused.map((r) => r.reason).sort()).toEqual(['no_access', 'self']);
    });
  });

  it('ignores rubbish rather than failing', async () => {
    // The ids come off the wire; anything at all may arrive.
    await inRollback(async (tx) => {
      const { owner, txn } = await scene(tx);
      const svc = mentionsFor(tx);
      for (const junk of [null, undefined, 'abc', [{}], ['x'], [-1], [0], [1.5], 'not-an-array']) {
        await expect(svc.resolve(asUser(owner), txn.id, junk)).resolves.toMatchObject({ allowed: [] });
      }
    });
  });

  it('caps how many people one message may name', async () => {
    // A guard against a paste that names everybody in the brokerage.
    await inRollback(async (tx) => {
      const { owner, txn } = await scene(tx);
      const many = Array.from({ length: MentionService.MAX_MENTIONS + 10 }, (_, i) => 100_000 + i);
      const result = await mentionsFor(tx).resolve(asUser(owner), txn.id, many);
      expect(result.allowed.length + result.refused.length).toBeLessThanOrEqual(MentionService.MAX_MENTIONS);
    });
  });
});

// ============================================================================ the autocomplete
describe('who the autocomplete offers', () => {
  it('offers only people who can already open the deal', async () => {
    /*
     * The list itself must not become a directory. Offering somebody who cannot see the deal would
     * both invite a mention that gets refused and reveal that they exist.
     */
    await inRollback(async (tx) => {
      const { owner, outsider, txn } = await scene(tx);
      const colleague = await makeUser(tx);
      await tx.team_members.create({ data: { transaction_id: txn.id, name: colleague.name } });

      const offered = await mentionsFor(tx).candidates(asUser(owner), txn.id);
      const ids = offered.map((c) => c.id);

      expect(ids).toContain(colleague.id);
      expect(ids).not.toContain(outsider.id);
    });
  });

  it('refuses the list to somebody who cannot open the deal', async () => {
    await inRollback(async (tx) => {
      const { outsider, txn } = await scene(tx);
      await expect(mentionsFor(tx).candidates(asUser(outsider), txn.id)).rejects.toThrow();
    });
  });
});

// ============================================================================ posting
describe('posting a message that mentions somebody', () => {
  it('notifies the mentioned person, once, with a link to the deal', async () => {
    await inRollback(async (tx) => {
      const { owner, outsider, txn } = await scene(tx);
      await tx.team_members.create({ data: { transaction_id: txn.id, name: outsider.name } });
      const { messages, sent } = chatWith(tx);

      await messages.post(txn.id, asUser(owner), 'please review this deal', [outsider.id]);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ userId: outsider.id, category: 'chat_mentions' });
      // Straight to the deal the conversation belongs to.
      expect(sent[0].link).toBe(`/desk/transactions/${txn.id}`);
    });
  });

  it('tells NOBODY when the person cannot open the deal', async () => {
    // The whole point, proved at the level people actually use.
    await inRollback(async (tx) => {
      const { owner, outsider, txn } = await scene(tx);
      const { messages, sent } = chatWith(tx);

      await messages.post(txn.id, asUser(owner), 'hello @outsider', [outsider.id]);

      expect(sent).toEqual([]);
    });
  });

  it('stores only the mentions it actually honoured', async () => {
    /*
     * The stored list is what the thread highlights. Storing a refused mention would show everybody
     * else that the outsider had been named — and imply they had been told.
     */
    await inRollback(async (tx) => {
      const { owner, outsider, txn } = await scene(tx);
      const colleague = await makeUser(tx);
      await tx.team_members.create({ data: { transaction_id: txn.id, name: colleague.name } });
      const { messages } = chatWith(tx);

      await messages.post(txn.id, asUser(owner), 'both of you', [colleague.id, outsider.id]);

      const row = await tx.transaction_messages.findFirst({ where: { transaction_id: txn.id } });
      expect(MentionService.decode(row!.mentions)).toEqual([colleague.id]);
    });
  });

  it('returns the mentions on the thread, so the client can highlight them', async () => {
    await inRollback(async (tx) => {
      const { owner, outsider, txn } = await scene(tx);
      await tx.team_members.create({ data: { transaction_id: txn.id, name: outsider.name } });
      const { messages } = chatWith(tx);

      const thread = await messages.post(txn.id, asUser(owner), 'over to you', [outsider.id]);
      expect(thread[0].mentions).toEqual([outsider.id]);
    });
  });

  it('notifies several people, each once', async () => {
    await inRollback(async (tx) => {
      const { owner, txn } = await scene(tx);
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      for (const person of [a, b]) {
        await tx.team_members.create({ data: { transaction_id: txn.id, name: person.name } });
      }
      const { messages, sent } = chatWith(tx);

      await messages.post(txn.id, asUser(owner), 'both please', [a.id, b.id, a.id]);

      expect(sent.map((s) => s.userId).sort()).toEqual([a.id, b.id].sort());
    });
  });

  it('gives each mention a key unique to the message and the person', async () => {
    /*
     * WHAT THIS PROTECTS. The chat has no edit today, so a message is dispatched once. If editing is
     * ever added, re-dispatching an edited message must tell only the people who were NOT named
     * before — the dispatcher drops a repeat by key, and a newly added mention gets a fresh one.
     * Asserting the key now is what makes that true later rather than a surprise.
     */
    await inRollback(async (tx) => {
      const { owner, txn } = await scene(tx);
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      for (const person of [a, b]) {
        await tx.team_members.create({ data: { transaction_id: txn.id, name: person.name } });
      }
      const { messages, sent } = chatWith(tx);

      await messages.post(txn.id, asUser(owner), 'both please', [a.id, b.id]);

      const row = await tx.transaction_messages.findFirst({ where: { transaction_id: txn.id } });
      expect(sent.map((s) => s.dedupeKey).sort()).toEqual(
        [`mention-${row!.id}-${a.id}`, `mention-${row!.id}-${b.id}`].sort(),
      );
    });
  });

  it('the agreed EDIT behaviour holds, against the real dispatcher', async () => {
    /*
     * THE RULE FOR EDITED MESSAGES, proved rather than designed.
     *
     *   newly added mention   → notified
     *   already notified      → NOT notified again
     *   removed mention       → nothing is retracted
     *   in-app notification   → remains, as the historical record
     *
     * The chat has no edit today, so this cannot be driven through `post`. What it does instead is
     * replay exactly what an edit WOULD do — dispatch the same message again with one person added
     * — against the real `NotificationDispatcher` and a real database, using the same dedupe key
     * `MessagesService` generates (asserted separately, above).
     *
     * The two halves were already covered apart: the key shape here, the dedupe in
     * `notification-dispatcher.spec.ts`. Neither on its own shows that an edit behaves correctly,
     * which is the thing actually being agreed.
     */
    await inRollback(async (tx) => {
      const { owner, txn } = await scene(tx);
      const first = await makeUser(tx);
      const added = await makeUser(tx);
      for (const person of [first, added]) {
        await tx.team_members.create({ data: { transaction_id: txn.id, name: person.name } });
      }

      // Only the in-app channel is resolvable here, which is the one an edit must not duplicate.
      const dispatcher = new NotificationDispatcher(
        tx,
        new NotificationPreferenceService(tx),
        { get: () => { throw new Error('absent'); } } as never,
      );

      const messageId = 4242;
      const mention = (userId: number) => dispatcher.dispatch({
        category: 'chat_mentions',
        userId,
        title: `${owner.name} mentioned you`,
        link: `/desk/transactions/${txn.id}`,
        dedupeKey: `mention-${messageId}-${userId}`,
      });

      // The original message.
      expect((await mention(first.id)).delivered).toContain('in_app');

      // The edit: the same person is named again, and a second person is added.
      const repeat = await mention(first.id);
      const fresh = await mention(added.id);

      expect(repeat.delivered).not.toContain('in_app');
      expect(repeat.skipped).toContainEqual({ channel: 'in_app', reason: 'duplicate' });
      expect(fresh.delivered).toContain('in_app');

      // One notification each, and the first person's original survives as the historical record.
      expect(await tx.notifications.count({ where: { user_id: first.id } })).toBe(1);
      expect(await tx.notifications.count({ where: { user_id: added.id } })).toBe(1);
    });
  });

  it('posts normally when nobody is mentioned', async () => {
    // Mentions are additive: the chat must behave exactly as it did for every message without one.
    await inRollback(async (tx) => {
      const { owner, txn } = await scene(tx);
      const { messages, sent } = chatWith(tx);

      const thread = await messages.post(txn.id, asUser(owner), 'just talking');

      expect(thread).toHaveLength(1);
      expect(thread[0].mentions).toEqual([]);
      expect(sent).toEqual([]);
      const row = await tx.transaction_messages.findFirst({ where: { transaction_id: txn.id } });
      expect(row!.mentions).toBeNull();
    });
  });

  it('still refuses to post into a deal the author cannot open', async () => {
    // Mentions must not have widened the door they are written through.
    await inRollback(async (tx) => {
      const { owner, outsider, txn } = await scene(tx);
      const { messages, sent } = chatWith(tx);

      await expect(messages.post(txn.id, asUser(outsider), 'let me in', [owner.id])).rejects.toThrow();
      expect(sent).toEqual([]);
      expect(await tx.transaction_messages.count({ where: { transaction_id: txn.id } })).toBe(0);
    });
  });
});
