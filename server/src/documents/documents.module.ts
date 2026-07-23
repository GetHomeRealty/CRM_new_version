import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { SettingsModule } from '../settings/settings.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentDefaultsService } from './document-defaults.service';
import { DocsValidationService } from './docs-validation.service';

@Module({
  imports: [AuthModule, EmailModule, SettingsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentDefaultsService, DocsValidationService],
})
export class DocumentsModule {}
