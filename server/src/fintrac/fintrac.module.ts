import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClientIdentificationController } from './client-identification.controller';
import { ClientIdentificationService } from './client-identification.service';
import { IdExtractionService } from './id-extraction.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';

@Module({
  imports: [AuthModule],
  controllers: [ClientIdentificationController],
  providers: [ClientIdentificationService, IdExtractionService, LaravelCryptService],
})
export class FintracModule {}
