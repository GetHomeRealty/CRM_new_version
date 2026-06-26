<?php

namespace App\Services;

use App\Models\Invoice;
use Illuminate\Support\Carbon;

/**
 * §12.4 — derives the auto "Invoice sent status" shown (read-only) in a
 * transaction's Admin Activities block. Never stored; always computed from the
 * invoice + closing/due date so it stays current.
 *
 * Priority:
 *   1. Paid                              → Received
 *   2. raised / sent by email (non-draft)→ Sent
 *   3. Draft + closing/due reached/passed→ Drafted + Pending
 *   4. Draft                             → Drafted
 *   5. no invoice + within 10 days of due→ Pending
 *   6. no invoice + due reached/passed   → Pending
 *   (no invoice + due far away           → "" / not yet)
 */
class InvoiceStatusService
{
    public const PENDING_WINDOW_DAYS = 10;

    /**
     * @param  Invoice|null  $invoice  the transaction's invoice (term invoice for precon), or null
     * @param  Carbon|string|null  $closingOrDue  invoice due date, else the transaction closing date
     */
    public function sentStatus(?Invoice $invoice, $closingOrDue = null): string
    {
        $due = $closingOrDue ? Carbon::parse($closingOrDue)->startOfDay() : null;
        $today = Carbon::now()->startOfDay();
        $duePassed = $due && $due->lte($today);
        $within10 = $due && ! $duePassed && $today->gte($due->copy()->subDays(self::PENDING_WINDOW_DAYS));

        if ($invoice) {
            if ($invoice->status === 'Paid') {
                return 'Received';                       // 1
            }
            if ($invoice->status === 'Void') {
                return 'Void';
            }
            $isDraft = $invoice->status === 'Draft';
            if (! $isDraft) {
                return 'Sent';                           // 2 — raised / emailed
            }
            if ($duePassed) {
                return 'Drafted + Pending';              // 3
            }

            return 'Drafted';                            // 4
        }

        // No invoice yet.
        if ($within10 || $duePassed) {
            return 'Pending';                            // 5 / 6
        }

        return '';
    }
}
