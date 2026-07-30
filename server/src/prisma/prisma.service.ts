import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { tenantExtension } from '../core/tenant-extension';

/**
 * Thin wrapper around PrismaClient with Nest lifecycle hooks. Attempts to connect
 * on module init and disconnects on shutdown. The connect is non-fatal: Prisma
 * connects lazily on first query anyway, so the HTTP server can still boot (and
 * serve DB-free routes like /api/health) before Postgres is provisioned.
 *
 * TENANT ISOLATION IS APPLIED HERE, so every caller gets it without asking. `$extends` returns a
 * NEW object rather than modifying the client, and this class is what the whole application has
 * injected — so the extended client is put behind a proxy that forwards model access to it. Every
 * `this.prisma.leads.findMany(...)` already written in the application therefore runs scoped, with
 * no call site edited and no import changed.
 *
 * `$transaction` forwards too, so work inside a transaction is scoped exactly like work outside it.
 * The lifecycle methods stay on this object, because connecting and disconnecting are this class's
 * own business and have no tenant.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super();
    // The getter closes over `extended` so the ownership check inside the extension can use the
    // scoped client — which cannot be referenced before it exists.
    const extended = this.$extends(tenantExtension(() => extended)) as unknown as Record<string, unknown>;
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && (prop === '$transaction' || (!prop.startsWith('$') && !prop.startsWith('_') && prop in extended))) {
          const v = extended[prop];
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(extended) : v;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (err) {
      this.logger.warn(
        `Database not reachable at startup — connecting lazily on first query. (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
