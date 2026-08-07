import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toDateTimeString } from '../common/serialize';
import type { ResourceUser } from './transaction.resource';
import { ResourceAccessService } from '../core/resource-access.service';
import { MentionService } from './mention.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';

export interface ChatMessage {
  id: number;
  author: string | null;
  body: string;
  at: string | null;
  mine: boolean;
  /** User ids this message mentions, so the client can highlight them. */
  mentions: number[];
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResourceAccessService,
    private readonly mentions: MentionService,
    /** Optional so existing constructions — including this service's specs — keep working. */
    private readonly dispatcher?: NotificationDispatcher,
  ) {}

  /**
   * Return the thread, marking it read for the requesting user (mirrors messages()).
   *
   * The access check is the fix for a real hole: this endpoint took a transaction id and returned
   * its chat to anyone signed in, so an agent with no part in a deal could read the whole
   * conversation about it — commission disputes included. Every other route hanging off a
   * transaction refused them; this one did not, because nothing here ever asked.
   */
  async list(txnId: number, user: ResourceUser | null): Promise<ChatMessage[]> {
    await this.access.assertTransaction(user, txnId);
    if (user) {
      const now = new Date();
      await this.prisma.transaction_message_reads.upsert({
        where: { transaction_id_user_id: { transaction_id: txnId, user_id: user.id } },
        create: { transaction_id: txnId, user_id: user.id, last_read_at: now, created_at: now, updated_at: now },
        update: { last_read_at: now, updated_at: now },
      });
    }
    const msgs = await this.prisma.transaction_messages.findMany({
      where: { transaction_id: txnId },
      orderBy: { id: 'asc' },
    });
    return msgs.map((m) => ({
      id: m.id,
      author: m.author,
      body: m.body,
      at: toDateTimeString(m.created_at),
      mine: m.user_id === (user?.id ?? null),
      mentions: MentionService.decode(m.mentions),
    }));
  }

  /**
   * Post a message, then return the (now-read) thread (mirrors postMessage).
   *
   * `mentionIds` are what the client's autocomplete resolved as the author typed. They are a
   * REQUEST, not a decision: every one is re-checked here against who may open this deal, because
   * anything a client sends is something a caller can forge — and the cost of getting it wrong is
   * telling an outsider that a deal exists.
   */
  async post(
    txnId: number,
    user: ResourceUser | null,
    body: string,
    mentionIds: unknown = [],
  ): Promise<ChatMessage[]> {
    // Writing into someone else's thread is the worse half of the same hole.
    await this.access.assertTransaction(user, txnId);

    const resolved = await this.mentions.resolve(user, txnId, mentionIds);

    const now = new Date();
    const message = await this.prisma.transaction_messages.create({
      data: {
        transaction_id: txnId,
        user_id: user?.id ?? null,
        author: user?.name ?? 'User',
        body,
        // Only the ids that survived every check are stored, so the highlight in the thread and the
        // people who were notified are the same set — a stored mention nobody was told about would
        // read, to everyone else, as though they had been.
        mentions: MentionService.encode(resolved.allowed),
        created_at: now,
        updated_at: now,
      },
      select: { id: true },
    });

    await this.notifyMentioned(message.id, txnId, user, body, resolved.allowed);
    return this.list(txnId, user);
  }

  /**
   * Tell the people this message named.
   *
   * All three channels at once — this is a new sender, so the dispatcher decides every one of them
   * from the person's own preferences rather than the call site guessing.
   *
   * `dedupeKey` is the message and the person, which is what makes this safe to call again: if the
   * chat ever gains editing, re-dispatching an edited message notifies only the people who were not
   * named before, and nobody is told twice about the same message.
   *
   * Never allowed to fail the post. The message is the record and it has already been written.
   */
  private async notifyMentioned(
    messageId: number,
    txnId: number,
    author: ResourceUser | null,
    body: string,
    recipients: number[],
  ): Promise<void> {
    if (!recipients.length || !this.dispatcher) return;

    const txn = await this.prisma.transactions.findUnique({
      where: { id: txnId },
      select: { trade_no: true, property: true },
    });
    const where = [txn?.trade_no, txn?.property].filter(Boolean).join(' · ');
    const excerpt = body.trim().replace(/\s+/g, ' ').slice(0, 180);

    for (const userId of recipients) {
      await this.dispatcher.dispatch({
        category: 'chat_mentions',
        userId,
        title: `${author?.name ?? 'Someone'} mentioned you${where ? ` on ${where}` : ''}`,
        body: excerpt,
        // Straight to the deal the conversation belongs to.
        link: `/desk/transactions/${txnId}`,
        dedupeKey: `mention-${messageId}-${userId}`,
      }).catch(() => {});
    }
  }
}
