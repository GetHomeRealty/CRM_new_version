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
  /**
   * Deliberately unscoped work.
   *
   * A few things genuinely have to see across every brokerage, and they are all infrastructure
   * rather than features: finding the user a session belongs to (which happens BEFORE anyone knows
   * their tenant), loading the permission tables at start-up, and the sweep each background timer
   * makes to find out which tenants it has work for.
   *
   * This flag is what separates those from a query that simply forgot. Once authorization fails
   * closed, "no tenant" is an error — and the only way to read across tenants is to say so.
   */
  system?: boolean;
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
 * Run infrastructure work that legitimately spans every brokerage.
 *
 * Deliberately awkward to reach for: it is exported, named for what it is, and every use of it is
 * counted by a test. Reading across tenants should require a decision, not an omission.
 */
export async function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ companyId: null, system: true }, async () => await fn());
}

/** Is the code currently running doing so as system infrastructure? */
export function isSystemContext(): boolean {
  return storage.getStore()?.system === true;
}

/**
 * Run `fn` once per tenant, each pass inside that tenant's own context.
 *
 * This is what a background job does instead of querying the whole table. A timer has no request
 * to inherit a tenant from, so before this it simply saw everything — which was harmless while one
 * brokerage existed and becomes one brokerage's reminders being sent about another's deals the
 * moment a second one does.
 *
 * The tenant list itself is read as system, because finding out who the tenants are is exactly the
 * kind of question that cannot be asked from inside a tenant.
 */
export async function forEachTenant<T>(
  tenants: () => Promise<number[]>,
  fn: (companyId: number) => Promise<T>,
): Promise<T[]> {
  const ids = await runAsSystem(tenants);
  const out: T[] = [];
  for (const id of ids) {
    // Sequential on purpose: these are background sweeps, and one brokerage's slow mailbox should
    // not be able to starve another's by running them all at once.
    out.push(await run(id, () => fn(id)));
  }
  return out;
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
