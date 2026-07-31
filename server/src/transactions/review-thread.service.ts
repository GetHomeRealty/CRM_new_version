import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isAdminOrAbove, isAgent } from '../core/authz';
import { toDateTimeString } from '../common/serialize';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * The conversation about one review item, and the evidence attached to it.
 *
 * WHY PER ITEM. The deal already has a chat, and that is where the team talks about the deal. It
 * cannot answer "which of these four rejections are you replying to?", which is exactly the question
 * that matters when an agent is working through a list. So a decision still announces itself in the
 * deal chat, and the argument about it happens here, against the item it belongs to.
 *
 * WHAT IS IMMUTABLE AND WHAT IS NOT. The decision is immutable; the conversation is append-only.
 * Nobody edits or deletes a message once written — for the same reason the decision cannot be
 * rewritten, and because a thread somebody can tidy afterwards is not a record of what was said.
 */

/** A screenshot is the point, so the ceiling is generous; the count keeps a thread readable. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_POST = 5;

export interface PostedAttachment {
  filename: string;
  content_type?: string;
  /** Base64; a full `data:` URI from a file input is accepted too. */
  data: string;
}

@Injectable()
export class ReviewThreadService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Post a reply on a review item.
   *
   * An agent's first message is also their first response, and that stamp is written once and never
   * moved: "how long before anyone answered" has to stay a fact about what happened rather than
   * about the most recent thing that happened.
   */
  async post(user: AuthUserRecord | null, reviewId: number, body: string, files: PostedAttachment[] = []): Promise<Record<string, unknown>[]> {
    const review = await this.reviewFor(user, reviewId);
    const text = String(body ?? '').trim();
    if (!text && files.length === 0) {
      throw new BadRequestException({ message: 'Write something, or attach a file.', errors: { body: ['The message cannot be empty.'] } });
    }

    const decoded = this.decode(files);
    const now = new Date();

    const message = await this.prisma.transaction_review_messages.create({
      data: {
        review_id: reviewId,
        transaction_id: review.transaction_id,
        user_id: user?.id ?? null,
        author: user?.name ?? 'User',
        author_role: user?.role ?? null,
        body: text,
        created_at: now,
        updated_at: now,
      },
    });

    for (const f of decoded) {
      await this.prisma.transaction_review_attachments.create({
        data: {
          message_id: message.id,
          filename: f.name,
          content_type: f.mime,
          size: f.bytes.length,
          data: new Uint8Array(f.bytes),
          uploaded_by: user?.name ?? null,
          created_at: now,
        },
      });
    }

    // Only the agent's reply counts as the response — the office answering its own rejection is not
    // the thing the metric is measuring.
    if (user && isAgent(user) && !review.first_response_at) {
      await this.prisma.transaction_reviews.update({
        where: { id: reviewId },
        data: { first_response_at: now, updated_at: now },
      });
    }

    return this.list(user, reviewId);
  }

  /** The thread, oldest first — a conversation reads downwards. */
  async list(user: AuthUserRecord | null, reviewId: number): Promise<Record<string, unknown>[]> {
    await this.reviewFor(user, reviewId);
    const rows = await this.prisma.transaction_review_messages.findMany({
      where: { review_id: reviewId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      include: { attachments: { select: { id: true, filename: true, content_type: true, size: true } } },
    });
    return rows.map((m) => ({
      id: m.id,
      author: m.author,
      author_role: m.author_role,
      body: m.body,
      created_at: toDateTimeString(m.created_at),
      attachments: m.attachments,
    }));
  }

  /** Attach evidence to the decision itself, rather than to a message — used when rejecting. */
  async attachToReview(user: AuthUserRecord | null, reviewId: number, files: PostedAttachment[]): Promise<number> {
    await this.reviewFor(user, reviewId);
    if (!isAdminOrAbove(user)) throw new ForbiddenException({ message: 'Administrator access required.' });
    const decoded = this.decode(files);
    const now = new Date();
    for (const f of decoded) {
      await this.prisma.transaction_review_attachments.create({
        data: {
          review_id: reviewId,
          filename: f.name,
          content_type: f.mime,
          size: f.bytes.length,
          data: new Uint8Array(f.bytes),
          uploaded_by: user?.name ?? null,
          created_at: now,
        },
      });
    }
    return decoded.length;
  }

  /** Everything hanging off a decision itself, for the history panel. */
  async reviewAttachments(reviewIds: number[]): Promise<Record<number, { id: number; filename: string; size: number }[]>> {
    const ids = [...new Set(reviewIds)].filter((n) => Number.isFinite(n));
    if (ids.length === 0) return {};
    const rows = await this.prisma.transaction_review_attachments.findMany({
      where: { review_id: { in: ids } },
      select: { id: true, review_id: true, filename: true, size: true },
      orderBy: { id: 'asc' },
    });
    const out: Record<number, { id: number; filename: string; size: number }[]> = {};
    for (const r of rows) if (r.review_id) (out[r.review_id] ??= []).push({ id: r.id, filename: r.filename, size: r.size });
    return out;
  }

  /** One attachment's bytes, behind the same access check as the review it belongs to. */
  async attachment(user: AuthUserRecord | null, attachmentId: number): Promise<{ filename: string; contentType: string; data: Buffer }> {
    const row = await this.prisma.transaction_review_attachments.findUnique({
      where: { id: attachmentId },
      include: { review: { select: { id: true } }, message: { select: { review_id: true } } },
    });
    if (!row) throw new NotFoundException({ message: 'Attachment not found.' });

    const reviewId = row.review?.id ?? row.message?.review_id;
    if (!reviewId) throw new NotFoundException({ message: 'Attachment not found.' });
    await this.reviewFor(user, reviewId);

    return { filename: row.filename, contentType: row.content_type, data: Buffer.from(row.data) };
  }

  /**
   * The review, if this person may see it: anyone above agent, and the agent whose deal it is.
   *
   * The same rule the history panel uses. Repeated here rather than trusted from the caller because
   * a thread reachable by id alone would be a way to read another agent's review by guessing.
   */
  private async reviewFor(user: AuthUserRecord | null, reviewId: number) {
    const review = await this.prisma.transaction_reviews.findUnique({
      where: { id: reviewId },
      select: { id: true, transaction_id: true, first_response_at: true, transactions: { select: { agent: true, deleted_at: true } } },
    });
    if (!review || review.transactions?.deleted_at) throw new NotFoundException({ message: 'Review not found.' });
    if (!user || !isAgent(user)) return review;

    const name = user.name ?? '';
    const allowed =
      review.transactions?.agent === name ||
      (await this.prisma.team_members.findFirst({ where: { transaction_id: review.transaction_id, name } })) !== null;
    if (!allowed) throw new ForbiddenException({ message: 'You do not have access to this transaction.' });
    return review;
  }

  /** Decode and check the files, before anything is written. */
  private decode(files: PostedAttachment[]): { name: string; mime: string; bytes: Buffer }[] {
    if (files.length === 0) return [];
    if (files.length > MAX_ATTACHMENTS_PER_POST) {
      throw new BadRequestException({ message: `Attach at most ${MAX_ATTACHMENTS_PER_POST} files to one message.` });
    }

    let total = 0;
    return files.map((f) => {
      const name = String(f.filename ?? '').trim() || 'attachment';
      const base64 = String(f.data ?? '').replace(/^data:[^;]+;base64,/, '');
      if (!base64) throw new BadRequestException({ message: `"${name}" is empty.` });

      let bytes: Buffer;
      try { bytes = Buffer.from(base64, 'base64'); }
      catch { throw new BadRequestException({ message: `"${name}" could not be read.` }); }
      if (bytes.length === 0) throw new BadRequestException({ message: `"${name}" is empty.` });

      total += bytes.length;
      if (total > MAX_ATTACHMENT_BYTES) {
        const mb = (MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0);
        throw new BadRequestException({
          message: `Attachments total ${(total / 1024 / 1024).toFixed(1)} MB, above the ${mb} MB limit.`,
        });
      }
      return { name: name.slice(0, 255), mime: String(f.content_type ?? '').trim().slice(0, 128) || 'application/octet-stream', bytes };
    });
  }
}
