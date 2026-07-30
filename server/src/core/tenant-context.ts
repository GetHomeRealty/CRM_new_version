import { AsyncLocalStorage } from 'async_hooks';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Which brokerage the code currently running belongs to.
 *
 * Every query needs to know this, and threading a company id through 681 call sites would mean
 * every one of them could forget. `AsyncLocalStorage` carries it alongside the call stack instead,
 * so the Prisma layer can read it without anyone passing it.
 *
 * WHY MIDDLEWARE AND NOT A GUARD. `AsyncLocalStorage.run` is only in effect for the duration of the
 * callback it is given. A guard returns `true` and unwinds before the route handler is called, so a
 * context established there would already be gone by the time anything queried. Middleware is the
 * one place that wraps the whole request, `next()` and all.
 *
 * That leaves an ordering problem — middleware runs BEFORE authentication, so it cannot know the
 * tenant yet. So it opens an empty store and `AuthGuard` fills it in once it has loaded the user.
 * The store is a mutable object held by reference, which is what makes filling it in later work.
 *
 * Nothing reads this yet. The Prisma extension that consumes it lands in phase 3; until then this
 * records the tenant and changes no behaviour.
 */

interface TenantStore {
  /** Null between the start of a request and the point authentication identifies the caller. */
  companyId: number | null;
}

const storage = new AsyncLocalStorage<TenantStore>();

/**
 * The company every existing row belongs to.
 *
 * This deployment has exactly one brokerage and `company_settings` has exactly one row, id 1. Named
 * rather than written as a bare `1` in a dozen places, so the day a second brokerage exists there is
 * one thing to find rather than a dozen.
 */
export const DEFAULT_COMPANY_ID = 1;

/** Open an empty context for a request. Called by the middleware, not by application code. */
export function enter<T>(fn: () => T): T {
  return storage.run({ companyId: null }, fn);
}

/**
 * Run something as a named tenant. For background jobs, scripts and tests, which have no request.
 *
 * The `await` inside is load-bearing, not a style choice. A Prisma promise is LAZY — building the
 * query does nothing until something awaits it — so `run(id, () => prisma.leads.findMany())` used to
 * return an unstarted promise, let this scope exit, and then run the query with no tenant in
 * context at all. It filtered nothing, silently, and the caller could not tell.
 *
 * Awaiting here keeps the query's execution inside the scope, whatever shape of callback is passed.
 */
export async function run<T>(companyId: number, fn: () => Promise<T>): Promise<T> {
  return storage.run({ companyId }, async () => await fn());
}

/**
 * Name the tenant for the request already in progress.
 *
 * Called by `AuthGuard` once it knows who is calling. Silently does nothing outside a context, so a
 * caller that authenticates outside a request — a test, a script — is not an error.
 */
export function setCompanyId(companyId: number): void {
  const store = storage.getStore();
  if (store) store.companyId = companyId;
}

/** The current tenant, or null when nothing has established one. */
export function currentCompanyId(): number | null {
  return storage.getStore()?.companyId ?? null;
}

/**
 * The current tenant, or an error.
 *
 * Phase 3 will call this from the Prisma extension, where the honest answer to "which brokerage is
 * this query for?" cannot be a guess. Unlike module access — which fails OPEN, because the cost of a
 * missing subscription row is someone seeing a screen they might not have bought — a missing tenant
 * fails CLOSED. The cost of guessing wrong here is one brokerage reading another's data, and there
 * is no default that is safe to assume.
 */
export function requireCompanyId(): number {
  const companyId = currentCompanyId();
  if (companyId === null) {
    throw new Error(
      'No tenant in context. A request should have one from AuthGuard; a background job or script ' +
        'must wrap its work in tenantContext.run(companyId, ...).',
    );
  }
  return companyId;
}

/** Opens the context for every request. Registered in `AppModule`. */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    enter(() => next());
  }
}
