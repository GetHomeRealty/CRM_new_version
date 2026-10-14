export type NotificationTarget = { kind: 'lead' | 'transaction'; id: number };

/** Only known relative record routes. Never pass server-provided links to a browser. */
export function notificationTarget(link: string): NotificationTarget | null {
  const match = /^(?:\/crm\/lead\/([1-9]\d*)|\/desk\/transactions\/([1-9]\d*))$/.exec(link);
  if (!match) return null;
  const id = Number(match[1] || match[2]);
  if (!Number.isSafeInteger(id)) return null;
  return { kind: match[1] ? 'lead' : 'transaction', id };
}
