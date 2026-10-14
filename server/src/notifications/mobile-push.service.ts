import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const TOKEN = /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{10,100}\]$/;
const DAY = 24 * 60 * 60 * 1000;
type ExpoResult = { status?: string; id?: string; details?: { error?: string } };

/** Native push is opt-in. Tokens belong to a revocable mobile session, never a browser cookie. */
@Injectable()
export class MobilePushService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  constructor(private readonly prisma: PrismaService) {}

  configured(): boolean {
    return process.env.NATIVE_PUSH_ENABLED === 'true' && Boolean(process.env.EXPO_PUSH_ACCESS_TOKEN?.trim());
  }
  async status(userId: number, sid: string | undefined) {
    await this.session(userId, sid);
    if (!this.configured()) return { enabled: false, registered: false };
    const row = await this.prisma.mobile_push_devices.findUnique({ where: { session_sid: sid! } });
    return { enabled: true, registered: Boolean(row) };
  }
  async register(userId: number, sid: string | undefined, body: Record<string, unknown>) {
    const session = await this.session(userId, sid);
    if (!this.configured()) throw new ServiceUnavailableException('Native push is not enabled.');
    if (typeof body.token !== 'string' || !TOKEN.test(body.token) || !['ios', 'android'].includes(String(body.platform))) throw new BadRequestException('Invalid native registration.');
    const token = body.token;
    const expires_at = new Date(Math.min(session.expire.getTime(), Date.now() + DAY));
    await this.prisma.$transaction(async tx => {
      // One installation/token has only one current account/session binding. A new session takes it over.
      await tx.mobile_push_devices.deleteMany({ where: { push_token: token, session_sid: { not: sid! } } });
      await tx.mobile_push_devices.upsert({ where: { session_sid: sid! },
        create: { user_id: userId, session_sid: sid!, push_token: token, platform: String(body.platform), expires_at },
        update: { push_token: token, platform: String(body.platform), expires_at },
      });
    });
    return { registered: true };
  }
  async remove(userId: number, sid: string | undefined) {
    await this.session(userId, sid);
    await this.prisma.mobile_push_devices.deleteMany({ where: { user_id: userId, session_sid: sid! } });
    return { registered: false };
  }
  private async session(userId: number, sid: string | undefined) {
    if (!sid?.startsWith('mobile:')) throw new UnauthorizedException('A mobile session is required.');
    const row = await this.prisma.user_sessions.findUnique({ where: { sid } });
    const payload = row?.sess as { mobile?: unknown; userId?: unknown } | undefined;
    if (!row || row.expire <= new Date() || payload?.mobile !== true || payload.userId !== userId) throw new UnauthorizedException('Mobile session is unavailable.');
    return row;
  }

  /** Generic lock-screen text. Read record details only after authenticated app access. No automatic send retries. */
  async sendToUser(userId: number): Promise<{ accepted: number; failed: number }> {
    const result = { accepted: 0, failed: 0 };
    if (!this.configured()) return result;
    const user = await this.prisma.users.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user || user.status === 'Inactive') return result;
    const rows = await this.prisma.mobile_push_devices.findMany({ where: { user_id: userId, expires_at: { gt: new Date() }, session: { expire: { gt: new Date() } } }, take: 20 });
    for (const row of rows) {
      try {
        // Recheck session ownership at dispatch; FK cascade handles logout/revocation.
        await this.session(userId, row.session_sid);
        const response = await this.postExpo('send', { to: row.push_token, title: 'Get Home Hub', body: 'You have a new update. Open Get Home Hub to view it.', data: { kind: 'hub-update', userId }, channelId: 'hub-updates', ttl: 300 });
        const ticket = (response as { data?: ExpoResult }).data;
        if (ticket?.status === 'ok' && typeof ticket.id === 'string' && ticket.id.length <= 128) {
          await this.prisma.mobile_push_receipts.create({ data: { ticket_id: ticket.id, device_id: row.id, push_token: row.push_token } });
          result.accepted++;
        } else {
          if (ticket?.details?.error === 'DeviceNotRegistered') await this.prisma.mobile_push_devices.deleteMany({ where: { id: row.id, push_token: row.push_token } });
          result.failed++;
        }
      } catch { result.failed++; }
    }
    return result;
  }
  /** Ticket acceptance is not delivery. Receipts remove invalid tokens without deleting later replacements. */
  async pollReceipts(): Promise<void> {
    if (!this.configured() || this.polling) return;
    this.polling = true;
    try {
      const now = Date.now();
      await this.prisma.mobile_push_receipts.deleteMany({ where: { created_at: { lt: new Date(now - DAY) } } });
      const rows = await this.prisma.mobile_push_receipts.findMany({ where: { status: 'pending', created_at: { lte: new Date(now - 15 * 60 * 1000) } }, take: 50 });
      if (!rows.length) return;
      const response = await this.postExpo('getReceipts', { ids: rows.map(row => row.ticket_id) });
      const data = (response as { data?: Record<string, ExpoResult> }).data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      for (const row of rows) {
        const receipt = data[row.ticket_id];
        if (!receipt || !['ok', 'error'].includes(receipt.status ?? '')) continue;
        if (receipt.details?.error === 'DeviceNotRegistered') await this.prisma.mobile_push_devices.deleteMany({ where: { id: row.device_id, push_token: row.push_token } });
        await this.prisma.mobile_push_receipts.updateMany({ where: { ticket_id: row.ticket_id }, data: { status: receipt.status === 'ok' ? 'delivered' : 'failed' } });
      }
    } finally { this.polling = false; }
  }
  protected async postExpo(action: 'send' | 'getReceipts', body: object): Promise<unknown> {
    // Isolated development must replace this method with a mock, never enable a live provider in tests.
    if (!this.configured() || process.env.NODE_ENV === 'test') throw new Error('Live push transport is disabled.');
    const response = await fetch(`https://exp.host/--/api/v2/push/${action}`, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${process.env.EXPO_PUSH_ACCESS_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Push provider request failed.');
    return response.json();
  }
  onModuleInit() {
    if (!this.configured() || process.env.NODE_ENV === 'test' || process.env.RUN_SCHEDULERS === 'false') return;
    this.timer = setInterval(() => { void this.pollReceipts().catch(() => { /* Next read-only receipt sweep can recover. */ }); }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
