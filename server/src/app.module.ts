import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { AppController } from './app.controller';
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
    PrismaModule,
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
  controllers: [AppController],
  providers: [
    // Global CSRF protection (Sanctum double-submit); safe methods are exempt.
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule {}
