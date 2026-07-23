import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Per-user MLS favorites. A favorite is a listing key plus a small snapshot of the listing
 * (address/price/beds/…), so the Favorites page renders without re-hitting the MLS feed for every
 * card. Everything is scoped to the signed-in user — a favorite is private to whoever saved it.
 */
@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  private toItem(row: Prisma.favoritesGetPayload<Record<string, never>>): Record<string, unknown> {
    return {
      id: row.id,
      listing_key: row.listing_key,
      snapshot: (row.snapshot as unknown) ?? {},
      notes: row.notes ?? '',
      created_at: row.created_at?.toISOString() ?? null,
    };
  }

  async list(user: AuthUserRecord): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.favorites.findMany({
      where: { user_id: user.id ?? -1 },
      orderBy: { created_at: 'desc' },
    });
    return rows.map((r) => this.toItem(r));
  }

  /** The set of listing keys this user has favorited — cheap check for the MLS search/detail hearts. */
  async keys(user: AuthUserRecord): Promise<string[]> {
    const rows = await this.prisma.favorites.findMany({
      where: { user_id: user.id ?? -1 },
      select: { listing_key: true },
    });
    return rows.map((r) => r.listing_key);
  }

  /** Add if absent, remove if present. Returns the new state. */
  async toggle(user: AuthUserRecord, listingKey: string, snapshot: unknown): Promise<{ favorited: boolean }> {
    const key = String(listingKey || '').trim();
    if (!key) throw new BadRequestException({ error: 'A listing key is required.' });
    const userId = user.id ?? -1;

    const existing = await this.prisma.favorites.findUnique({
      where: { user_id_listing_key: { user_id: userId, listing_key: key } },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.favorites.delete({ where: { id: existing.id } });
      return { favorited: false };
    }

    await this.prisma.favorites.create({
      data: {
        user_id: userId,
        listing_key: key,
        snapshot: (snapshot ?? {}) as Prisma.InputJsonValue,
        created_at: new Date(),
      },
    });
    return { favorited: true };
  }

  async remove(user: AuthUserRecord, listingKey: string): Promise<{ success: boolean }> {
    const key = String(listingKey || '').trim();
    await this.prisma.favorites.deleteMany({ where: { user_id: user.id ?? -1, listing_key: key } });
    return { success: true };
  }
}
