/** A transaction chat message (GET/POST /api/transactions/:id/messages). */
export interface ChatMessage {
  id: number | string;
  author?: string;
  at?: string;
  body?: string;
  mine?: boolean;
  [key: string]: unknown;
}
