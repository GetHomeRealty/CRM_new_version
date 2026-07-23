import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GoogleModule } from '../google/google.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { TodosController } from './todos.controller';
import { TodosService } from './todos.service';

// AuditService comes from the global AuditModule.
// TodosController is registered first so `calendar/todos` is matched before CalendarController's
// routes — its own paths are all under `calendar/events`, but ordering keeps that guaranteed.
@Module({
  imports: [AuthModule, GoogleModule],
  controllers: [TodosController, CalendarController],
  providers: [CalendarService, TodosService],
})
export class CalendarModule {}
