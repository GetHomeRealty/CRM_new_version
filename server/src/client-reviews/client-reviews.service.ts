import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { transactionScopeWhere } from '../common/transaction-scope';
import type { AuthUserRecord } from '../auth/auth.types';

const CLOSED = ['Closed', 'Sold', 'Leased'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = { id: true, transaction_id: true, client_name: true, client_email: true, status: true, rating: true, comment: true, created_at: true, expires_at: true, submitted_at: true } as const;
export function reviewInput(body: { token?: unknown; rating?: unknown; comment?: unknown }) {
  if (typeof body?.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) throw new BadRequestException('Review link is unavailable.');
  if (!Number.isInteger(body.rating) || Number(body.rating) < 1 || Number(body.rating) > 5) throw new BadRequestException('Choose a rating from 1 to 5.');
  if (typeof body.comment !== 'string' || !body.comment.trim() || body.comment.trim().length > 5000) throw new BadRequestException('Enter a review of 1–5000 characters.');
  return { hash: createHash('sha256').update(body.token).digest('hex'), rating: Number(body.rating), comment: body.comment.trim() };
}
@Injectable()
export class ClientReviewsService {
  constructor(private readonly prisma: PrismaService, private readonly mailer: MailerService) {}
  private owner(user: AuthUserRecord): number {
    if (!Number.isSafeInteger(user.id) || Number(user.id) < 1) throw new NotFoundException();
    return user.id!;
  }
  private key(): Buffer {
    const value = process.env.APP_KEY || '';
    const key = Buffer.from(value.startsWith('base64:') ? value.slice(7) : value, 'base64');
    if (key.length !== 32) throw new ServiceUnavailableException('Client review link encryption is not configured.');
    return key;
  }
  private seal(link: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const data = Buffer.concat([cipher.update(link, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  private open(ciphertext: string): string {
    try {
      const data = Buffer.from(ciphertext, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key(), data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    } catch { throw new ServiceUnavailableException('Client review link could not be recovered.'); }
  }
  async link(user: AuthUserRecord, id: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('Invalid request.');
    const row = await this.prisma.client_review_requests.findFirst({ where: { id, owner_user_id: this.owner(user), status: { in: ['ready', 'sent', 'uncertain', 'sending'] }, expires_at: { gt: new Date() } }, select: { link_ciphertext: true } });
    if (!row) throw new NotFoundException('Review link is unavailable.');
    return { link: this.open(row.link_ciphertext) };
  }
  async list(user: AuthUserRecord, before?: number) {
    const owner = this.owner(user);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new BadRequestException('Invalid page.');
    const rows = await this.prisma.client_review_requests.findMany({ where: { owner_user_id: owner, ...(before ? { id: { lt: before } } : {}) }, orderBy: { id: 'desc' }, take: 31, select: fields });
    return { data: rows.slice(0, 30), next: rows.length > 30 ? rows[29].id : null, email_enabled: process.env.CLIENT_REVIEWS_EMAIL_ENABLED === 'true' };
  }
  async mailboxes(user: AuthUserRecord) {
    return this.prisma.mail_accounts.findMany({ where: { user_id: this.owner(user), is_active: true, OR: [{ scope: 'crm' }, { scope: null }] }, select: { id: true, name: true }, take: 30 });
  }
  async choices(user: AuthUserRecord, search: string) {
    return this.prisma.transactions.findMany({ where: { AND: [transactionScopeWhere(user), { transaction_statuses: { some: { status: { in: CLOSED } } } }, { OR: [{ trade_no: { contains: search.slice(0, 100), mode: 'insensitive' } }, { property: { contains: search.slice(0, 100), mode: 'insensitive' } }] }] }, select: { id: true, trade_no: true, property: true, clients: { select: { id: true, name: true, email: true } } }, orderBy: { id: 'desc' }, take: 30 });
  }
  async request(user: AuthUserRecord, body: { transaction_id?: unknown; client_id?: unknown; submission_id?: unknown; send_email?: unknown; account_id?: unknown }) {
    const owner = this.owner(user);
    if (!Number.isSafeInteger(body?.transaction_id) || Number(body.transaction_id) < 1 || !Number.isSafeInteger(body.client_id) || Number(body.client_id) < 1 || typeof body.submission_id !== 'string' || !UUID.test(body.submission_id) || typeof body.send_email !== 'boolean') throw new BadRequestException('Choose a closed transaction and client.');
    const prior = await this.prisma.client_review_requests.findUnique({ where: { owner_user_id_submission_id: { owner_user_id: owner, submission_id: body.submission_id } }, select: fields });
    if (prior) return { request: prior, link: ['ready', 'sent', 'uncertain', 'sending'].includes(prior.status) && prior.expires_at > new Date() ? (await this.link(user, prior.id)).link : null };
    const transaction = await this.prisma.transactions.findFirst({ where: { AND: [{ id: Number(body.transaction_id) }, transactionScopeWhere(user), { transaction_statuses: { some: { status: { in: CLOSED } } } }] }, select: { clients: { where: { id: Number(body.client_id) }, select: { id: true, name: true, email: true } } } });
    const client = transaction?.clients[0];
    if (!client) throw new NotFoundException('Closed transaction/client unavailable.');
    if (!client.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.email) || client.email.length > 255) throw new BadRequestException('This client needs a valid email address.');
    let origin: URL;
    try { origin = new URL(process.env.CLIENT_REVIEWS_PUBLIC_URL || ''); } catch { throw new ServiceUnavailableException('Client review response URL is not configured.'); }
    const local = ['http:', 'https:'].includes(origin.protocol) && process.env.NODE_ENV === 'test' && ['localhost', '127.0.0.1'].includes(origin.hostname);
    if ((!local && origin.protocol !== 'https:') || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new ServiceUnavailableException('Client review response URL must be an HTTPS origin.');
    if (body.send_email && (process.env.CLIENT_REVIEWS_EMAIL_ENABLED !== 'true' || !Number.isSafeInteger(body.account_id) || Number(body.account_id) < 1)) throw new BadRequestException('Review email sending is disabled or no owned mailbox was chosen.');
    if (body.send_email && !await this.prisma.mail_accounts.findFirst({ where: { id: Number(body.account_id), user_id: owner, is_active: true, OR: [{ scope: 'crm' }, { scope: null }] }, select: { id: true } })) throw new BadRequestException('Owned sending mailbox unavailable.');
    const token = randomBytes(32).toString('hex');
    const link = `${origin.origin}/api/client-reviews/respond#${token}`;
    const link_ciphertext = this.seal(link);
    let row;
    try { row = await this.prisma.client_review_requests.create({ data: { owner_user_id: owner, transaction_id: Number(body.transaction_id), client_id: client.id, submission_id: body.submission_id, link_ciphertext, token_hash: createHash('sha256').update(token).digest('hex'), client_name: client.name, client_email: client.email, status: body.send_email ? 'sending' : 'ready', expires_at: new Date(Date.now() + 30 * 86400000) }, select: fields }); }
    catch (error) { if ((error as { code?: string }).code !== 'P2002') throw error; return { request: await this.prisma.client_review_requests.findUnique({ where: { owner_user_id_submission_id: { owner_user_id: owner, submission_id: body.submission_id } }, select: fields }), link: null }; }
    if (body.send_email) {
      let status = 'sent';
      try { await this.mailer.sendOwnedReplyOnce(owner, Number(body.account_id), client.email, 'Share your experience with Get Home Hub', `<p>Please share your experience with Get Home Hub.</p><p><a href="${link}">Write your review</a></p><p>This private link expires in 30 days. Your feedback is visible to the staff member who requested it; it is not published.</p>`, []); }
      catch { status = 'uncertain'; }
      // Submission/cancellation can race SMTP; never overwrite those terminal states.
      await this.prisma.client_review_requests.updateMany({ where: { id: row.id, status: 'sending' }, data: { status } });
      row = (await this.prisma.client_review_requests.findFirst({ where: { id: row.id, owner_user_id: owner }, select: fields }))!;
    }
    return { request: row, link };
  }
  async cancel(user: AuthUserRecord, id: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('Invalid request.');
    const result = await this.prisma.client_review_requests.updateMany({ where: { id, owner_user_id: this.owner(user), status: { in: ['ready', 'sent', 'uncertain', 'sending'] } }, data: { status: 'cancelled' } });
    if (!result.count) throw new NotFoundException('Request unavailable or already submitted.');
    return { cancelled: true };
  }
  async submit(body: { token?: unknown; rating?: unknown; comment?: unknown }) {
    const input = reviewInput(body);
    const result = await this.prisma.client_review_requests.updateMany({ where: { token_hash: input.hash, status: { in: ['ready', 'sending', 'sent', 'uncertain'] }, expires_at: { gt: new Date() } }, data: { status: 'submitted', rating: input.rating, comment: input.comment, submitted_at: new Date() } });
    if (!result.count) throw new NotFoundException('Review link has expired, was cancelled, or was already used.');
    return { submitted: true };
  }
}
