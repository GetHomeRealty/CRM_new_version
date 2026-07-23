import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { TodosService, TODO_PRIORITIES, TODO_STATUSES, type TodoInput, type TodoQuery } from './todos.service';

/**
 * The Calendar screen's todo list — a quick personal checklist, so it shares the `calendar`
 * screen permission. Reading needs view; adding, editing and deleting need edit.
 */
@Controller('calendar/todos')
@UseGuards(AuthGuard, ScreenGuard)
export class TodosController {
  constructor(private readonly todos: TodosService) {}

  /** Vocabularies for the filter dropdowns. */
  @Get('options')
  @Screen('calendar', 'view')
  options(): Record<string, unknown> {
    return { statuses: [...TODO_STATUSES], priorities: [...TODO_PRIORITIES] };
  }

  @Get()
  @Screen('calendar', 'view')
  list(@CurrentUser() user: AuthUserRecord, @Query() q: TodoQuery): Promise<unknown> {
    return this.todos.list(user, q ?? {});
  }

  @Post()
  @HttpCode(201)
  @Screen('calendar', 'edit')
  create(@CurrentUser() user: AuthUserRecord, @Body() body: TodoInput): Promise<unknown> {
    return this.todos.create(body ?? {}, user);
  }

  @Put(':id')
  @Screen('calendar', 'edit')
  update(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: TodoInput): Promise<unknown> {
    return this.todos.update(id, body ?? {}, user);
  }

  @Delete(':id')
  @Screen('calendar', 'edit')
  remove(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.todos.remove(id, user);
  }
}
