<?php

namespace App\Services;

use App\Models\CompanySetting;
use Illuminate\Support\Facades\DB;

/**
 * Generates the next invoice number (prefix + continuous counter) and advances
 * the counter atomically. Format mirrors Zoho, e.g. INV-601107 → INV-601108.
 */
class InvoiceNumberService
{
    public function next(): string
    {
        return DB::transaction(function () {
            $settings = CompanySetting::query()->lockForUpdate()->firstOrCreate(['id' => 1]);
            $no = (int) $settings->next_invoice_no;
            $settings->update(['next_invoice_no' => $no + 1]);

            return $settings->invoice_prefix.$no;
        });
    }

    /**
     * §12.5 — invoice number tied to the transaction Trade No.:
     *   normal:           GHR-<trade>          e.g. GHR-200654
     *   preconstruction:  GHR-<trade>_Term <n> e.g. GHR-300100_Term 1
     * Returns null when there is no trade number (caller falls back to next()).
     */
    public function forTransaction(?string $tradeNo, ?int $termNo = null): ?string
    {
        if (! $tradeNo) {
            return null;
        }

        return 'GHR-'.$tradeNo.($termNo ? "_Term {$termNo}" : '');
    }
}
