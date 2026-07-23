import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MlsController } from './mls.controller';
import { MlsService } from './mls.service';

@Module({
  imports: [AuthModule],
  controllers: [MlsController],
  providers: [MlsService],
  exports: [MlsService],
})
export class MlsModule {}
