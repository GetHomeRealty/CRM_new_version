import { Controller, Get } from '@nestjs/common';

/** Liveness probe (mirrors Laravel's `/up`, but under the API prefix). */
@Controller()
export class AppController {
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }
}
