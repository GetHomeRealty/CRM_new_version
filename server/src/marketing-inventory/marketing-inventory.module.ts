import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarketingInventoryController } from './marketing-inventory.controller';
import { MarketingInventoryService } from './marketing-inventory.service';

@Module({
  imports: [AuthModule],
  controllers: [MarketingInventoryController],
  providers: [MarketingInventoryService],
})
export class MarketingInventoryModule {}
