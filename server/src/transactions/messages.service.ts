import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toDateTimeString } from '../common/serialize';
import type { ResourceUser } from './transaction.resource';

export interface ChatMessage {
  id: number;
  author: string | null;
  body: string;
  at: string | null;
  mine: boolean;
}

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Return the thread, marking it read for the requesting user (mirrors messages()). */
  async list(txnId: number, user: ResourceUser | null): Promise<ChatMessage[]> {
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
