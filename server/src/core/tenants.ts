import type { PrismaService } from '../prisma/prisma.service';

/**
 * Every brokerage in the deployment.
 *
 * Asked only by background work, which has no request to inherit a tenant from and therefore has to
 * be told who the tenants are. `forEachTenant` reads it inside a system context, because finding
 * out which brokerages exist is precisely the question that cannot be asked from inside one.
 */
export async function allTenantIds(prisma: PrismaService): Promise<number[]> {
  const rows = await prisma.company_settings.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  return rows.map((r) => r.id);
}
