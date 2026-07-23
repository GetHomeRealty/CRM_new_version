import api from './axios';
import type { MlsProperty } from './mlsApi';

export interface Favorite {
  id: number;
  listing_key: string;
  snapshot: MlsProperty;
  notes: string;
  created_at: string | null;
}

export const listFavorites = (): Promise<Favorite[]> =>
  api.get<Favorite[]>('/api/favorites').then((r) => r.data);

/** Listing keys the current user has favorited — to light up hearts on the MLS screens. */
export const favoriteKeys = (): Promise<string[]> =>
  api.get<string[]>('/api/favorites/keys').then((r) => r.data);

export const toggleFavorite = (listingKey: string, snapshot: MlsProperty): Promise<{ favorited: boolean }> =>
  api.post<{ favorited: boolean }>('/api/favorites/toggle', { listing_key: listingKey, snapshot }).then((r) => r.data);

export const removeFavorite = (listingKey: string): Promise<{ success: boolean }> =>
  api.delete<{ success: boolean }>(`/api/favorites/${encodeURIComponent(listingKey)}`).then((r) => r.data);
