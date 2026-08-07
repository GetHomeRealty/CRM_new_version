import { Global, Module } from '@nestjs/common';
import { QueueService } from './queue.service';
import { QueueController } from './queue.controller';
import { AuthModule } from '../auth/auth.module';

/**
 * Global for the same reason as RedisModule: anything may need to enqueue work, and threading an
 * import through every feature module to do so would be noise. The controller is admin-only.
 */
@Global()
@Module({
  /*
   * AuthModule for the guards on the controller. Not a cycle: this module is @Global, so AuthModule
   * (and everything else) can inject QueueService WITHOUT importing it back — which is the property
   * that keeps the graph acyclic while still letting the auth path enqueue work.
   */
  imports: [AuthModule],
  controllers: [QueueController],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
