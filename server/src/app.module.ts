import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TenantContextMiddleware } from './core/tenant-context';
import { ThrottlerModule } from '@nestjs/throttler';
import { IdentityThrottlerGuard } from './core/identity-throttler.guard';
import configuration from './config/configuration';
import { GLOBAL_LIMIT } from './config/rate-limits';
import { PrismaModule } from './prisma/prisma.module';
import { CoreModule } from './core/core.module';
import { AppController } from './app.controller';
import { HealthController } from './observability/health.controller';
import { RequestLogInterceptor } from './observability/request-log.interceptor';
import { ErrorLogFilter } from './observability/error-log.filter';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CsrfGuard } from './auth/guards/csrf.guard';
import { AgentsModule } from './agents/agents.module';
import { SuggestionsModule } from './suggestions/suggestions.module';
import { ReferenceModule } from './reference/reference.module';
import { CommissionModule } from './transactions/commission.module';
import { TransactionsModule } from './transactions/transactions.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { SettingsModule } from './settings/settings.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { NotificationsModule } from './notifications/notifications.module';
import { InvoicesModule } from './invoices/invoices.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { UsersModule } from './users/users.module';
import { RecycleBinModule } from './recycle-bin/recycle-bin.module';
import { EmailModule } from './email/email.module';
import { DocumentsModule } from './documents/documents.module';
import { FintracModule } from './fintrac/fintrac.module';
import { QuickActionsModule } from './quick-actions/quick-actions.module';
import { ReportsModule } from './reports/reports.module';
import { CalendarModule } from './calendar/calendar.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { LeadsModule } from './leads/leads.module';
import { MetaModule } from './meta/meta.module';
import { CrmSettingsModule } from './crm-settings/crm-settings.module';
import { SmsModule } from './sms/sms.module';
import { AccountModule } from './account/account.module';
import { InboxModule } from './inbox/inbox.module';
import { GoogleModule } from './google/google.module';
import { MarketingInventoryModule } from './marketing-inventory/marketing-inventory.module';
import { MlsModule } from './mls/mls.module';
import { FavoritesModule } from './favorites/favorites.module';
import { TwilioVoiceModule } from './twilio-voice/twilio-voice.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    // Rate limiting. Keyed by SIGNED-IN USER where there is one, falling back to client IP — the
    // real one, because `trust proxy` is set in main.ts; without that every request would look like
    // it came from nginx and the whole site would share a single bucket. See
    // core/identity-throttler.guard.ts for why an IP-keyed bucket was the wrong shape here: an
    // office shares one address, so it made the ceiling depend on how many colleagues were working.
    //
    // Exactly ONE bucket belongs here. Every throttler listed applies to every route, so the
    // stricter sign-in limit is an endpoint-level override rather than a second entry — see
    // config/rate-limits.ts, which explains why and is regression-tested.
    ThrottlerModule.forRoot([GLOBAL_LIMIT]),
    PrismaModule,
    // The Core Platform layer both modules sit on.
    CoreModule,
    AuditModule,
    CommissionModule,
    AuthModule,
    AgentsModule,
    SuggestionsModule,
    ReferenceModule,
    TransactionsModule,
    DashboardModule,
    SettingsModule,
    WorkflowsModule,
    NotificationsModule,
    InvoicesModule,
    AuditLogModule,
    UsersModule,
    RecycleBinModule,
    EmailModule,
    DocumentsModule,
    FintracModule,
    QuickActionsModule,
    ReportsModule,
    CalendarModule,
    CampaignsModule,
    LeadsModule,
    MetaModule,
    CrmSettingsModule,
    SmsModule,
    AccountModule,
    InboxModule,
    GoogleModule,
    MarketingInventoryModule,
    MlsModule,
    FavoritesModule,
    TwilioVoiceModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    // One structured line per request, with a correlation id every other line inherits.
    { provide: APP_INTERCEPTOR, useClass: RequestLogInterceptor },
    // Records unhandled errors and then hands them straight back to Nest — the response shape on
    // the wire is unchanged, because the client reads it.
    { provide: APP_FILTER, useClass: ErrorLogFilter },
    // Global CSRF protection (Sanctum double-submit); safe methods are exempt.
    { provide: APP_GUARD, useClass: CsrfGuard },
    // Rate limiting for every route. Provider callbacks that legitimately burst — Twilio status
    // webhooks during a bulk send, Meta lead deliveries — opt out with @SkipThrottle on their
    // controllers, since throttling those drops real data rather than turning away an attacker.
    { provide: APP_GUARD, useClass: IdentityThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  /**
   * Opens a tenant context around every request.
   *
   * Registered here rather than in CoreModule because middleware has to wrap the whole request, and
   * `AsyncLocalStorage` only holds for the callback it is given — a guard or an interceptor would
   * unwind before the handler queried anything.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
