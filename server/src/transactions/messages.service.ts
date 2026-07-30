import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toDateTimeString } from '../common/serialize';
import type { ResourceUser } from './transaction.resource';
import { ResourceAccessService } from '../core/resource-access.service';

export interface ChatMessage {
  id: number;
  author: string | null;
  body: string;
  at: string | null;
  mine: boolean;
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResourceAccessService,
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
    }));
  }

  /** Post a message, then return the (now-read) thread (mirrors postMessage). */
  async post(txnId: number, user: ResourceUser | null, body: string): Promise<ChatMessage[]> {
    // Writing into someone else's thread is the worse half of the same hole.
    await this.access.assertTransaction(user, txnId);
    const now = new Date();
    await this.prisma.transaction_messages.create({
      data: {
        transaction_id: txnId,
        user_id: user?.id ?? null,
        author: user?.name ?? 'User',
        body,
        created_at: now,
        updated_at: now,
      },
    });
    return this.list(txnId, user);
  }
}
