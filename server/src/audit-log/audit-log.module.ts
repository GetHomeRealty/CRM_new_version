import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';
import { AuditExportService } from './audit-export.service';

@Module({
  imports: [AuthModule],
  controllers: [AuditLogController],
  providers: [AuditExportService, AuditLogService],
})
export class AuditLogModule {}
