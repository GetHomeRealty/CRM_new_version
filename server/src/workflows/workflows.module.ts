import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationDispatcherModule } from '../notifications/notification-dispatcher.module';
import { EditRequestsController } from './edit-requests.controller';
import { EditRequestsService } from './edit-requests.service';
import { DeleteRequestsController } from './delete-requests.controller';
import { DeleteRequestsService } from './delete-requests.service';

@Module({
  // The dispatcher module depends on nothing but the preference lookup, so importing it here
  // cannot close a cycle — see the note on `NotificationDispatcherModule` itself.
  imports: [AuthModule, NotificationDispatcherModule],
  controllers: [EditRequestsController, DeleteRequestsController],
  providers: [EditRequestsService, DeleteRequestsService],
})
export class WorkflowsModule {}
