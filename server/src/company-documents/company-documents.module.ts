import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { CompanyDocumentsController } from './company-documents.controller';
import { CompanyDocumentsService } from './company-documents.service';
import { CompanyDocumentReminderService } from './company-document-reminder.service';

/** Settings -> Company Documents (19 Oct 2026): each country's company papers and stakeholders. */
@Module({
  imports: [AuthModule, EmailModule],
  controllers: [CompanyDocumentsController],
  providers: [CompanyDocumentsService, CompanyDocumentReminderService],
})
export class CompanyDocumentsModule {}
