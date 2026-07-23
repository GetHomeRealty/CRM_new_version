import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin wrapper around PrismaClient with Nest lifecycle hooks. Attempts to connect
 * on module init and disconnects on shutdown. The connect is non-fatal: Prisma
 * connects lazily on first query anyway, so the HTTP server can still boot (and
 * serve DB-free routes like /api/health) before Postgres is provisioned.
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
