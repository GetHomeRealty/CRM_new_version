import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin wrapper around PrismaClient with Nest lifecycle hooks. Attempts to connect
 * on module init and disconnects on shutdown. The connect is non-fatal: Prisma
 * connects lazily on first query anyway, so the HTTP server can still boot (and
 * serve DB-free routes like /api/health) before Postgres is provisioned.
 *
 * THERE IS NO QUERY-LEVEL SCOPING HERE, and that is the point rather than an omission.
 *
 * This client used to carry a `$extends` tenant extension that added `company_id = N` to every
 * query, behind a proxy that forwarded model access to the extended client. The deployment serves
 * one brokerage, `company_settings` had exactly one row, and every `company_id` in the database was
 * therefore the same number — so the filter matched everything it was applied to and excluded
 * nothing. It cost a predicate on every query and bought nothing.
 *
 * WHAT ACTUALLY PROTECTS ONE AGENT FROM ANOTHER, and always did: `ResourceAccessService`, the
 * `ScreenGuard`/`AreaGuard` pair, `authz.ts`, the role/permission tables, and the owner predicates
 * written into the individual queries. None of those ever consulted `company_id` — a colleague's
 * lead and yours carried the same company, so the tenant filter was satisfied by both and answered
 * a question nobody was asking. Removing it changes what the database is asked; it does not change
 * who is allowed to ask.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

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
