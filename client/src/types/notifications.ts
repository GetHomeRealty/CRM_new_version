/** Notification payloads polled by the desk layout header bells. */

/** One agent-change-to-review item (admins/managers). */
export interface AgentChangeItem {
  id: number | string;
  unread?: boolean;
  property?: string;
  count?: number;
  trade_no?: number | string;
  agent?: string;
  at?: string;
}

/** GET /api/agent-change-notifications. */
export interface AgentChangeNotif {
  count: number;
  items: AgentChangeItem[];
}

/** One document-review-update item (agents). */
export interface DocNotifItem {
  id: number | string;
  unread?: boolean;
  property?: string;
  trade_no?: number | string;
  summary?: string;
  at?: string;
}

/** GET /api/doc-notifications. */
export interface DocNotif {
  count: number;
  items: DocNotifItem[];
}
