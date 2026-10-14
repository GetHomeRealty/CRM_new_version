import { MobileForm630Service } from './mobile-form630.service';
import { MobileForm630Controller } from './mobile-form630.controller';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClientIdentificationController } from './client-identification.controller';
import { ClientIdentificationService } from './client-identification.service';
import { IdExtractionService } from './id-extraction.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';

@Module({
  imports: [AuthModule],
  controllers: [ClientIdentificationController, MobileForm630Controller],
  providers: [MobileForm630Service, ClientIdentificationService, IdExtractionService, LaravelCryptService],
})
export class FintracModule {}
