import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EditRequestsController } from './edit-requests.controller';
import { EditRequestsService } from './edit-requests.service';
import { DeleteRequestsController } from './delete-requests.controller';
import { DeleteRequestsService } from './delete-requests.service';

@Module({
  imports: [AuthModule],
  controllers: [EditRequestsController, DeleteRequestsController],
  providers: [EditRequestsService, DeleteRequestsService],
})
export class WorkflowsModule {}
