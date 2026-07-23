import api from './axios';

/** A RESO/MLS listing — loose shape; the feed returns dozens of fields we render opportunistically. */
export type MlsProperty = Record<string, unknown> & {
  ListingKey?: string;
  UnparsedAddress?: string;
  City?: string;
  StateOrProvince?: string;
  PostalCode?: string;
  ListPrice?: number;
  BedroomsTotal?: number;
  BathroomsTotalInteger?: number;
  LivingArea?: number;
  PropertyType?: string;
  StandardStatus?: string;
};

export interface MlsSearchResult {
  properties: MlsProperty[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface MlsSearchParams {
  page?: number;
  search?: string;
  sort?: string;
  priceMin?: number;
  priceMax?: number | 'any';
  beds?: string;
  baths?: string;
  propertyType?: string;
  status?: string;
}

export const mlsStatus = (): Promise<{ configured: boolean }> =>
  api.get<{ configured: boolean }>('/api/mls/status').then((r) => r.data);

export const searchMls = (params: MlsSearchParams): Promise<MlsSearchResult> => {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === 'any') continue;
    q[k] = String(v);
  }
  return api.get<MlsSearchResult>('/api/mls', { params: q }).then((r) => r.data);
};

export const getMlsListing = (key: string): Promise<MlsProperty> =>
  api.get<MlsProperty>(`/api/mls/${encodeURIComponent(key)}`).then((r) => r.data);
