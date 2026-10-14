import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { type mail_accounts } from '@prisma/client';
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { PrismaService } from '../prisma/prisma.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { GoogleService } from '../google/google.service';
const LIMIT = 30, MAX_SOURCE = 1024 * 1024;
const scalar = (value: unknown, limit = 255): string => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit) : '';
export function sentUid(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,9}$/.test(String(value)) || Number(value) > 4294967295) throw new BadRequestException('Invalid Sent mailbox reference.');
  return Number(value);
}
export interface SentReference { account?: string; validity?: string; cursor?: string }
@Injectable()
export class ProviderSentService {
  private readonly pending = new Set<number>();
  constructor(private readonly prisma: PrismaService, private readonly crypt: LaravelCryptService, private readonly google: GoogleService) {}
  private async account(userId: number, expected?: string) {
    if (!Number.isSafeInteger(userId) || userId < 1) throw new NotFoundException('Mailbox unavailable.');
    const account = (await this.prisma.mail_accounts.findFirst({ where: { user_id: userId, is_default: true } }))
      ?? (await this.prisma.mail_accounts.findFirst({ where: { user_id: userId, is_active: true }, orderBy: { id: 'asc' } }));
    if (expected !== undefined && (!account || account.id !== sentUid(expected))) throw new NotFoundException('Mailbox changed. Refresh Sent mail.');
    return account?.is_active ? account : null;
  }
  private summary(row: FetchMessageObject) {
    const date = row.envelope?.date || row.internalDate;
    return { uid: row.uid, subject: scalar(row.envelope?.subject), from: scalar(row.envelope?.from?.map(a => a.address).join(', '), 1024),
      to: scalar(row.envelope?.to?.slice(0, 20).map(a => a.address).join(', '), 2048), sent_at: date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null };
  }
  async list(userId: number, reference: SentReference = {}, signal?: AbortSignal) {
    const account = await this.account(userId, reference.account);
    if (!account || !account.imap_host || process.env.PROVIDER_SENT_ENABLED !== 'true') return { available: false, data: [], next_cursor: null, account_id: account?.id ?? null, validity: null };
    if (reference.cursor !== undefined && (!reference.account || !reference.validity)) throw new BadRequestException('Refresh Sent mail before paging.');
    const cursor = reference.cursor !== undefined ? sentUid(reference.cursor) : null;
    return this.read(userId, account, reference.validity, signal, async client => {
      let upper = client.mailbox ? client.mailbox.exists : 0;
      if (!Number.isSafeInteger(upper) || upper < 0) throw new ServiceUnavailableException('Sent mailbox unavailable.');
      if (cursor) { const previous = await client.fetchOne(String(cursor), { uid: true }, { uid: true }); if (!previous || previous.uid !== cursor || !Number.isSafeInteger(previous.seq) || previous.seq < 1) throw new NotFoundException('Sent page changed. Refresh the list.'); upper = previous.seq - 1; }
      const start = Math.max(1, upper - LIMIT + 1), rows: FetchMessageObject[] = [];
      if (upper > 0) for await (const row of client.fetch(`${start}:${upper}`, { uid: true, envelope: true, internalDate: true })) { if (rows.length >= LIMIT) throw new ServiceUnavailableException('Sent mailbox response exceeded its limit.'); rows.push(row); }
      rows.sort((a, b) => b.uid - a.uid);
      return { available: true, data: rows.map(row => this.summary(row)), next_cursor: start > 1 && rows.length ? rows[rows.length - 1].uid : null, account_id: account.id, validity: client.mailbox ? client.mailbox.uidValidity.toString() : '' };
    });
  }
  async detail(userId: number, uidInput: string, reference: SentReference, signal?: AbortSignal) {
    const uid = sentUid(uidInput);
    if (!reference.account || !reference.validity) throw new BadRequestException('Open the message from the Sent list.');
    const account = await this.account(userId, reference.account);
    if (!account?.imap_host || process.env.PROVIDER_SENT_ENABLED !== 'true') throw new NotFoundException('Sent mailbox unavailable.');
    return this.read(userId, account, reference.validity, signal, async client => {
      const row = await client.fetchOne(String(uid), { uid: true, envelope: true, internalDate: true, size: true, source: { start: 0, maxLength: MAX_SOURCE + 1 } }, { uid: true });
      if (!row || row.uid !== uid) throw new NotFoundException('Sent message unavailable.');
      if (!row.source || row.source.length > MAX_SOURCE || (row.size ?? 0) > MAX_SOURCE) return { ...this.summary(row), body_text: null, body_html: null, content_available: false, truncated: true, attachments: [] };
      const parsed = await simpleParser(row.source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
      const html = typeof parsed.html === 'string' ? parsed.html : null, text = parsed.text ?? null;
      return { ...this.summary(row), body_text: text?.slice(0, 200000) ?? null, body_html: html?.slice(0, 200000) ?? null, content_available: true,
        truncated: (text?.length ?? 0) > 200000 || (html?.length ?? 0) > 200000 || parsed.attachments.length > 20,
        attachments: parsed.attachments.slice(0, 20).map(file => ({ filename: scalar(file.filename || 'Attachment'), size: file.size, content_type: scalar(file.contentType, 128) })) };
    });
  }
  /** Overridden only by isolated test mocks; no live provider networking in test mode. */
  protected async createClient(account: mail_accounts): Promise<ImapFlow> {
    if (process.env.NODE_ENV === 'test') throw new ServiceUnavailableException('Live Sent transport is disabled in tests.');
    const secret = this.crypt.decryptString(account.password);
    if (!secret) throw new ServiceUnavailableException('Reconnect this mailbox on the Hub website.');
    const auth = account.encryption === 'oauth'
      ? { user: account.username || account.from_email, accessToken: (await this.google.refresh(secret, 'mail')).access_token }
      : { user: account.username || account.from_email, pass: secret };
    const client = new ImapFlow({ host: account.imap_host!, port: account.imap_port ?? 993, secure: account.imap_encryption !== 'tls', doSTARTTLS: account.imap_encryption === 'tls', auth, logger: false, socketTimeout: 20000, connectionTimeout: 20000, greetingTimeout: 20000 });
    client.on('error', () => { /* Only generic errors are exposed to the client. */ });
    return client;
  }
  private async read<T>(userId: number, account: mail_accounts, validity: string | undefined, external: AbortSignal | undefined, work: (client: ImapFlow) => Promise<T>): Promise<T> {
    if (external?.aborted || this.pending.has(userId) || this.pending.size >= 64) throw new ServiceUnavailableException('Sent mailbox is busy or unavailable. Try again.');
    if (validity !== undefined) sentUid(validity);
    this.pending.add(userId);
    let client: ImapFlow | undefined, disposed = false;
    const controller = new AbortController();
    const abort = () => controller.abort(); external?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30000);
    const cancelled = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => { client?.close(); reject(new ServiceUnavailableException('Sent mailbox request cancelled.')); }, { once: true }));
    const action = async () => {
      const created = await this.createClient(account);
      if (disposed || controller.signal.aborted) { created.close(); throw new ServiceUnavailableException('Sent mailbox request cancelled.'); }
      client = created; await client.connect();
      if (controller.signal.aborted) throw new ServiceUnavailableException('Sent mailbox request cancelled.');
      const folders = await client.list();
      if (controller.signal.aborted) throw new ServiceUnavailableException('Sent mailbox request cancelled.');
      const special = folders.filter(folder => folder.specialUse === '\\Sent');
      const fallback = folders.filter(folder => ['sent', 'sent items', 'sent mail'].includes(folder.name.toLowerCase()));
      const candidates = special.length ? special : fallback;
      if (candidates.length !== 1) throw new NotFoundException('A unique Sent folder could not be identified. Use your mail provider.');
      const lock = await client.getMailboxLock(candidates[0].path, { readOnly: true });
      try {
        if (controller.signal.aborted) throw new ServiceUnavailableException('Sent mailbox request cancelled.');
        if (!client.mailbox || !/^[1-9]\d{0,9}$/.test(client.mailbox.uidValidity.toString()) || Number(client.mailbox.uidValidity) > 4294967295) throw new ServiceUnavailableException('Sent mailbox unavailable.');
        if (validity !== undefined && client.mailbox.uidValidity.toString() !== validity) throw new NotFoundException('Sent folder changed. Refresh the list.');
        return await work(client);
      } finally { lock.release(); }
    };
    try { return await Promise.race([action(), cancelled]); }
    catch (error) { if (error instanceof BadRequestException || error instanceof NotFoundException || error instanceof ServiceUnavailableException) throw error; throw new ServiceUnavailableException('Sent mailbox could not be read. Refresh or review the connection.'); }
    finally { disposed = true; clearTimeout(timer); external?.removeEventListener('abort', abort); client?.close(); this.pending.delete(userId); }
  }
}
