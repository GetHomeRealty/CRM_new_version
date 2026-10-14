import type { CampaignRecipient } from './campaigns-api';

/** Explain recorded server state without initiating retries or revealing SMTP diagnostics. */
export function deliverySummary(recipient: CampaignRecipient): string {
  if (recipient.bounce_type === 'hard') return 'Permanent delivery rejection. Check the address with your administrator before sending again.';
  if (recipient.bounce_type === 'soft') {
    const attempts = recipient.retry_count === undefined ? '' : ` Recorded retries: ${recipient.retry_count}.`;
    const next = recipient.next_retry_at ? ` Server-reported next retry: ${recipient.next_retry_at}.` : ' No next retry time is reported.';
    return `Temporary delivery rejection.${attempts}${next}`;
  }
  if (recipient.bounce_type === 'unknown') return 'Delivery system error. Ask your administrator to review it; this does not establish that the address is invalid.';
  if (recipient.bounced) return 'Delivery bounced. No bounce classification is available.';
  if (recipient.status === 'failed') return 'Delivery failed. Review the details with your administrator; no retry is triggered here.';
  if (recipient.status === 'pending') return 'Awaiting processing. No delivery result is recorded yet.';
  if (recipient.status === 'sent') return 'Recorded as sent. This does not confirm inbox placement or that the recipient read it.';
  return 'No additional delivery details are available.';
}
