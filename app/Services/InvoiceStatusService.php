<?php

namespace App\Services;

use App\Models\Invoice;
use Illuminate\Support\Carbon;

/**
 * Workflow "Invoice Status" shown (read-only) in Admin Activities and the Agent
 * FAQ Center. Never stored; always derived from the invoice so it stays current:
 *   - no invoice               → Pending to Raise
 *   - invoice status Paid      → Paid
 *   - invoice status Void      → Void
 *   - invoice sent (sent_at)   → Sent
 *   - otherwise (saved draft)  → Draft
 */
class InvoiceStatusService
{
    public const PENDING_WINDOW_DAYS = 10;

    /**
     * @param  Invoice|null  $invoice  the transaction's invoice (term invoice for precon), or null
     * @param  Carbon|string|null  $closingOrDue  kept for signature compatibility; unused
     */
    public function sentStatus(?Invoice $invoice, $closingOrDue = null): string
    {
        if (! $invoice) {
            return 'Pending to Raise';
        }
        if ($invoice->status === 'Paid') {
            return 'Paid';
        }
        if ($invoice->status === 'Void') {
            return 'Void';
        }
        if ($invoice->sent_at) {
            return 'Sent';
        }

        return 'Draft';
    }
}
