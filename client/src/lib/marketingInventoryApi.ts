import api from './axios';
import type { MarketingInventoryItem } from '../desk/marketingInventory';

/** Marketing / physical-asset inventory API. */

export interface InventoryListResponse {
  items: MarketingInventoryItem[];
  total: number;
}

export interface InventoryOptions {
  types: string[];
  statuses: string[];
  names: string[];
}

export interface SaveAssignment {
  assignedTo: string;
  qty: number;
  assignedDate?: string;
  returnedDate?: string;
}

export interface SaveInventoryPayload {
  asOnDate: string;
  type: string;
  customType?: string;
  count: number;
  remarks?: string;
  assignments: SaveAssignment[];
}

export const listInventory = (deleted = false): Promise<InventoryListResponse> =>
  api.get<InventoryListResponse>(`/api/marketing-inventory${deleted ? '?deleted=true' : ''}`).then((r) => r.data);

export const inventoryOptions = (): Promise<InventoryOptions> =>
  api.get<InventoryOptions>('/api/marketing-inventory/options').then((r) => r.data);

export const createInventory = (body: SaveInventoryPayload): Promise<{ merged: boolean; addedCount?: number; item: MarketingInventoryItem }> =>
  api.post('/api/marketing-inventory', body).then((r) => r.data);

export const updateInventory = (id: string, body: SaveInventoryPayload): Promise<{ success: boolean; item: MarketingInventoryItem }> =>
  api.put(`/api/marketing-inventory/${id}`, body).then((r) => r.data);

export const deleteInventory = (id: string, permanent = false): Promise<{ success: boolean; permanent: boolean }> =>
  api.delete(`/api/marketing-inventory/${id}${permanent ? '?permanent=true' : ''}`).then((r) => r.data);

export const restoreInventory = (id: string): Promise<{ success: boolean }> =>
  api.post(`/api/marketing-inventory/${id}/restore`).then((r) => r.data);
