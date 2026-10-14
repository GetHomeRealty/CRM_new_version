import type { LeadUpdate } from './leads-api';

/** A completed save acknowledges only the values submitted with that request. */
export function remainingLeadDraft(current: LeadUpdate, submitted: LeadUpdate): LeadUpdate {
  return Object.fromEntries(Object.entries(current).filter(([key, value]) =>
    !(key in submitted) || JSON.stringify(value) !== JSON.stringify(submitted[key as keyof LeadUpdate])
  )) as LeadUpdate;
}
