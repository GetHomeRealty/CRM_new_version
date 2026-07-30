import { Prisma } from '@prisma/client';
import { currentCompanyId, isSystemContext } from './tenant-context';

/**
 * Tenant isolation, applied to every query by the client itself.
 *
 * The alternative was to add `company_id` to 681 call sites by hand, which means 681 chances to
 * forget one — and a forgotten filter does not fail, it quietly returns another brokerage's data.
 * This puts the rule in one place that every query passes through.
 *
 * WHICH TABLES. Anything with a `company_id` column is scoped. That set is defined by the schema
 * rather than by a list kept here, so a table added later is covered the moment it carries the
 * column, and cannot be forgotten by someone editing an allow-list they never knew about.
 *
 * NO TENANT IN CONTEXT IS AN ERROR. A query against a tenant-owned table with nothing to scope it
 * by is a bug, and returning every brokerage rows to whoever asked is the worst possible way to
 * handle one. The three things that genuinely span tenants — resolving a session user, loading the
 * permission tables at start-up, and a timer discovering which tenants it has work for — say so
 * with `runAsSystem`, which is exported, named for what it is, and counted by a test.
 */

/** Operations whose `where` accepts an ordinary field, so the filter can simply be added. */
const FILTERABLE = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy',
  'updateMany', 'deleteMany',
]);

/** Operations that take a UNIQUE where, which cannot hold `company_id`. Handled separately. */
const UNIQUE_READ = new Set(['findUnique', 'findUniqueOrThrow']);
const UNIQUE_WRITE = new Set(['update', 'delete']);

/** Models carrying a tenant column, read from the schema so the list cannot drift. */
const SCOPED: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'company_id'))
    .map((m) => m.name),
);

type Args = Record<string, unknown>;

function withCompany(where: unknown, companyId: number): Args {
  const w = (where ?? {}) as Args;
  // Spelled as an AND rather than a top-level key so it cannot be overwritten by a caller's own
  // `company_id`, and cannot collide with an existing OR/NOT the caller already built.
  return { AND: [w, { company_id: companyId }] };
}

/** Scalar field names per model, for telling a real column from a compound-unique wrapper. */
const SCALARS: Record<string, Set<string>> = Object.fromEntries(
  Prisma.dmmf.datamodel.models.map((m) => [
    m.name,
    new Set(m.fields.filter((f) => f.kind !== 'object').map((f) => f.name)),
  ]),
);

/**
 * Turn a unique `where` into one `findFirst` accepts.
 *
 * `findUnique` takes compound keys as a nested object — `{ user_id_module_name: { user_id, module_name } }`
 * — which `findFirst` rejects, because that wrapper is not a column. Anything that is not a real
 * scalar of the model gets spread back into the fields it stands for.
 */
function flattenUnique(model: string, where: unknown): Args {
  const scalars = SCALARS[model] ?? new Set<string>();
  const out: Args = {};
  for (const [k, v] of Object.entries((where ?? {}) as Args)) {
    if (!scalars.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, v as Args);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * @param getClient returns the EXTENDED client, so the ownership check is itself tenant-scoped.
 *   A getter rather than the client itself because the client cannot exist before the extension it
 *   is built from.
 */
export function tenantExtension(getClient: () => unknown = () => null) {
  return Prisma.defineExtension({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !SCOPED.has(model)) {
            return query(args);
          }

          const companyId = currentCompanyId();
          if (companyId === null) {
            // FAIL CLOSED. A query against a tenant-owned table with no tenant in context is a bug,
            // and the safe answer to a bug is a loud one — the alternative is returning every
            // brokerage's rows to whoever asked. Infrastructure that genuinely spans tenants says
            // so with `runAsSystem`, which is exported, named, and counted by a test.
            if (isSystemContext()) return query(args);
            throw new Error(
              `No tenant in context for ${model}.${operation}. A request gets one from AuthGuard; ` +
                'background work must use forEachTenant, and infrastructure that genuinely spans ' +
                'brokerages must say so with runAsSystem.',
            );
          }

          const a = (args ?? {}) as Args;

          if (FILTERABLE.has(operation)) {
            return query({ ...a, where: withCompany(a.where, companyId) });
          }

          if (operation === 'create') {
            const data = (a.data ?? {}) as Args;
            // A caller that named a company explicitly keeps it — creating on behalf of another
            // tenant is a deliberate act, and silently rewriting it would hide a bug rather than
            // prevent one. Everything else is stamped with the tenant in context.
            return query({ ...a, data: 'company_id' in data ? data : { ...data, company_id: companyId } });
          }

          if (operation === 'createMany' || operation === 'createManyAndReturn') {
            const rows = a.data as Args | Args[];
            const stamp = (r: Args) => ('company_id' in r ? r : { ...r, company_id: companyId });
            return query({ ...a, data: Array.isArray(rows) ? rows.map(stamp) : stamp(rows) });
          }

          if (operation === 'upsert') {
            const create = (a.create ?? {}) as Args;
            // Cast because the generated upsert input is per-model and this callback is generic —
            // the shape is the caller's own args with one field added.
            return query({
              ...a,
              create: 'company_id' in create ? create : { ...create, company_id: companyId },
            } as typeof args);
          }

          /**
           * `findUnique` cannot be narrowed: Prisma only accepts unique fields in its `where`, so
           * `company_id` has nowhere to go. The row is fetched and then checked, which costs one
           * read of a row the caller already named and returns exactly what a scoped query would
           * have — nothing, when it belongs to somebody else.
           */
          if (UNIQUE_READ.has(operation)) {
            const row = (await query(args)) as { company_id?: number } | null;
            if (row && row.company_id !== undefined && row.company_id !== companyId) {
              if (operation === 'findUniqueOrThrow') {
                throw new Prisma.PrismaClientKnownRequestError('No record was found for a query.', {
                  code: 'P2025', clientVersion: Prisma.prismaVersion.client,
                });
              }
              return null;
            }
            return row;
          }

          /**
           * A write addressed by unique id is checked BEFORE it runs. Reading the row back
           * afterwards would be too late — the other brokerage's record would already have changed.
           *
           * The check goes through the extended client, so it is itself tenant-scoped: it finds the
           * row only if it belongs to the caller. Missing means "not yours or not there", and both
           * answer the same way Prisma answers a write against a row that does not exist.
           */
          if (UNIQUE_WRITE.has(operation)) {
            const client = getClient() as Record<string, { findFirst(a: Args): Promise<unknown> }> | null;
            if (client) {
              const owned = await client[model].findFirst({ where: flattenUnique(model, a.where) });
              if (!owned) {
                throw new Prisma.PrismaClientKnownRequestError(
                  `An operation failed because it depends on one or more records that were required but not found.`,
                  { code: 'P2025', clientVersion: Prisma.prismaVersion.client },
                );
              }
            }
            return query(args);
          }

          return query(args);
        },
      },
    },
  });
}
