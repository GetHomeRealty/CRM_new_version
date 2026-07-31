import { Controller } from '@nestjs/common';

/**
 * Root controller.
 *
 * The liveness probe used to live here as `@Get('health')` returning `{ status: 'ok' }`. It has
 * moved to `HealthController`, which serves that same path alongside `/api/health/ready` and
 * `/api/health/metrics` — leaving it here as well mapped `/api/health` twice and let whichever
 * controller Nest registered first win, which was this one. Liveness, readiness and metrics belong
 * together, and the response is unchanged apart from an added `uptime_s`.
 */
@Controller()
export class AppController {}
