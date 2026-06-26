<?php

namespace App\Services;

use App\Models\Invoice;

/**
 * Recomputes invoice money fields and status. HST is modelled as an
 * auto-calculated tax on taxable lines (spec Q2 recommended option).
 */
class InvoiceCalculator
{
    /** Term name → number of days for the due date. Custom = caller-supplied. */
    public const TERM_DAYS = [
        'Due on Receipt' => 0,
        'Net 7' => 7,
        'Net 15' => 15,
        'Net 30' => 30,
    ];

    public function recalculate(Invoice $invoice, float $taxRate): void
    {
        $items = $invoice->relationLoaded('lineItems') ? $invoice->lineItems : $invoice->lineItems()->get();
        $payments = $invoice->relationLoaded('payments') ? $invoice->payments : $invoice->payments()->get();

        $subTotal = 0.0;
        $taxable = 0.0;
        foreach ($items as $it) {
            $amount = round((float) $it->qty * (float) $it->rate, 2);
            $subTotal += $amount;
            if ($it->is_taxable) {
                $taxable += $amount;
            }
        }
        $taxTotal = round($taxable * $taxRate / 100, 2);
        $discount = round((float) ($invoice->discount ?? 0), 2);
        $total = round($subTotal + $taxTotal - $discount, 2);
        $paid = round($payments->sum('amount'), 2);
        $balance = round($total - $paid, 2);

        $invoice->sub_total = round($subTotal, 2);
        $invoice->tax_total = $taxTotal;
        $invoice->total = $total;
        $invoice->amount_paid = $paid;
        $invoice->balance_due = $balance;
        $invoice->status = $this->status($invoice->status, $total, $paid, $balance);
        $invoice->save();
    }

    /**
     * Explicitly-chosen statuses (the §12.2 set) stick — the user controls them in
     * the editor. Draft sticks until a payment exists. Otherwise derive from payment.
     */
    private function status(string $current, float $total, float $paid, float $balance): string
    {
        if (in_array($current, ['Void', 'Paid', 'Due', 'Overdue'], true)) {
            return $current;
        }
        if ($current === 'Draft' && $paid <= 0) {
            return 'Draft';
        }
        if ($total > 0 && $balance <= 0) {
            return 'Paid';
        }
        if ($paid > 0) {
            return 'Partially Paid';
        }

        return 'Unpaid';
    }
}
