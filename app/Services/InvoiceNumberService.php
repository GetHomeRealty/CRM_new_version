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
}
