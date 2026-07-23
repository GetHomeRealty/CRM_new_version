import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReferenceController } from './reference.controller';

@Module({
  imports: [AuthModule],
  controllers: [ReferenceController],
})
export class ReferenceModule {}
