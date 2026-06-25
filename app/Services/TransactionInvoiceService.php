<?php

namespace App\Services;

use App\Models\CompanySetting;
use App\Models\Invoice;
use App\Models\Transaction;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Generates commission invoice(s) from a transaction. Shared by the manual
 * "Generate Invoice" action and the automatic on-create generation. Mirrors the
 * original InvoiceController::generateForTransaction logic (Preconstruction =
 * one invoice per term; otherwise a single invoice).
 */
class TransactionInvoiceService
{
    public function __construct(
        private InvoiceNumberService $numbers,
        private InvoiceCalculator $calc,
        private CommissionService $commissions,
    ) {
    }

    /**
     * @param  bool  $skipIfExists  when true, do nothing if the transaction already has invoices
     * @return Invoice[]            the invoices created (empty if none)
     */
    public function generate(Transaction $transaction, bool $skipIfExists = false): array
    {
        if (! Transaction::isInvoiceableType($transaction->type)) {
            return [];
        }
        if ($skipIfExists && $transaction->invoices()->exists()) {
            return [];
        }

        $settings = CompanySetting::current();
        $transaction->loadMissing(['brokerage', 'teamMembers.terms', 'preconTerms']);
        $created = [];

        DB::transaction(function () use ($transaction, $settings, &$created) {
            $breakdown = $this->commissions->breakdown($transaction);

            if ($transaction->type === 'Preconstruction') {
                $terms = $breakdown['terms'] ?? [];
                if (count($terms) === 0) {
                    $created[] = $this->make($transaction, $settings, null, (float) ($breakdown['master']['commission'] ?? 0));
                } else {
                    foreach ($terms as $term) {
                        $created[] = $this->make($transaction, $settings, "Term {$term['term_no']}", (float) $term['commission']);
                    }
                }
            } else {
                $created[] = $this->make($transaction, $settings, null, (float) ($breakdown['commission'] ?? 0));
            }
        });

        return $created;
    }

    private function make(Transaction $t, CompanySetting $settings, ?string $termLabel, float $commission): Invoice
    {
        $b = $t->brokerage;
        $invoiceDate = Carbon::now();
        $suffix = $termLabel ? " — {$termLabel}" : '';

        $invoice = Invoice::create([
            'invoice_no' => $this->invoiceNumber($t, $termLabel),
            'transaction_id' => $t->id,
            'source' => 'transaction',
            'transaction_type' => $t->type,
            'created_by' => auth()->id(),
            'property_reference' => $t->property,
            'customer_name' => $b?->name,
            'customer_address' => $b?->address,
            'customer_country' => 'Canada',
            'invoice_date' => $invoiceDate->toDateString(),
            'terms' => $settings->default_terms,
            'due_date' => optional($this->dueDate($invoiceDate, $settings->default_terms))->toDateString(),
            'trade_number' => $t->trade_no,
            'listing_agent' => $t->agent,
            'coop_salesperson' => $t->agent,
            'subject' => 'Co-op Commission for '.$t->property.$suffix,
            'status' => 'Unpaid',
        ]);

        $invoice->lineItems()->create([
            'row_no' => 1,
            'description' => 'Co-op Commission'.$suffix,
            'qty' => 1,
            'rate' => round($commission, 2),
            'amount' => round($commission, 2),
            'is_taxable' => true,
        ]);

        $this->calc->recalculate($invoice, (float) $settings->default_tax_rate);

        return $invoice;
    }

    /**
     * Invoice number from the transaction Trade No.: GHR-<trade>, and for
     * Preconstruction terms GHR-<trade>_<Term N>. Falls back to the prefix
     * counter only if the transaction somehow has no trade number.
     */
    private function invoiceNumber(Transaction $t, ?string $termLabel): string
    {
        if (! $t->trade_no) {
            return $this->numbers->next();
        }
        $no = 'GHR-'.$t->trade_no;

        return $termLabel ? $no.'_'.$termLabel : $no;
    }

    private function dueDate(Carbon $invoiceDate, ?string $terms): ?Carbon
    {
        if (! $terms || $terms === 'Custom') {
            return null;
        }
        $days = InvoiceCalculator::TERM_DAYS[$terms] ?? null;

        return $days !== null ? $invoiceDate->copy()->addDays($days) : null;
    }
}
