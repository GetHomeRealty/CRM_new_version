import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { CacheService } from './cache.service';

/**
 * Global, because caching is cross-cutting: making every feature module import a cache module to
 * ask "is this already computed?" would add an import to almost every file for no benefit. The
 * services are stateless wrappers over one connection, so a single shared instance is also the
 * correct lifetime.
 */
@Global()
@Module({
  providers: [RedisService, CacheService],
  exports: [RedisService, CacheService],
})
export class RedisModule {}
