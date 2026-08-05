import { Module, type OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { PrismaService } from '../prisma/prisma.service';
import { forEachTenant } from '../core/tenant-context';
import { allTenantIds } from '../core/tenants';
import { CrmSettingsController } from './crm-settings.controller';
import { CrmSettingsService } from './crm-settings.service';
import { CrmAdvancedEmailService } from './crm-advanced-email.service';
import { CrmTriggersService } from './crm-triggers.service';

/**
 * CRM Settings, migrated from the CRM app.
 *
 * Mounted at `/api/crm-settings` in its own tables so Transaction Desk's existing settings
 * surfaces — company-settings, mail-accounts, email-templates — keep working untouched.
 * Overlap between the two is expected at this stage and will be reconciled later.
 */
@Module({
  imports: [AuthModule, EmailModule],
  controllers: [CrmSettingsController],
  providers: [CrmSettingsService, CrmAdvancedEmailService, CrmTriggersService],
  exports: [CrmSettingsService, CrmTriggersService],
})
export class CrmSettingsModule implements OnModuleInit {
  constructor(
    private readonly settings: CrmSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Close out any broadcast the previous run was still delivering when it stopped.
   *
   * NOT gated on `schedulersEnabled()`, deliberately, though every timer in this application is.
   * That flag exists so two processes do not both run a recurring job — two IMAP syncs racing on
   * one mailbox, two copies of a reminder reaching a real client. Neither hazard applies here: this
   * is a single bounded sweep at boot, it sends nothing, and it is idempotent — a second process
   * running it finds nothing left to close. Gating it would have meant the one deployment flag most
   * likely to be set on a second instance also silently disabled the repair, and `RUN_SCHEDULERS`
   * is off in the browser suite, so the fix would never have been exercised by a test either.
   *
   * `NODE_ENV=test` is still excluded: unit tests must not touch rows they did not create.
   *
   * Awaited rather than fired off, because it is one query against a small table and a broadcast
   * wrongly reading "sending" while the screen is already up is the exact state this removes.
   *
   * Run through `forEachTenant`, which is what background work does here instead of querying the
   * whole table: boot has no request to inherit a tenant from, and the Prisma extension refuses a
   * query that cannot say which brokerage it is for. The first version of this reached straight for
   * `prisma.crm_broadcasts` and was refused at boot with exactly that message — a good refusal,
   * caught because the fix's own test failed.
   */
  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await forEachTenant(
      () => allTenantIds(this.prisma),
      async () => { await this.settings.reconcileInterruptedBroadcasts(); },
    );
  }
}
