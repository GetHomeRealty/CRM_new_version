<?php

namespace App\Http\Controllers;

use App\Models\CompanySetting;
use App\Models\Invoice;
use App\Models\Transaction;
use App\Services\CommissionService;
use App\Services\InvoiceCalculator;
use App\Services\InvoiceNumberService;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class InvoiceController extends Controller
{
    public function __construct(private InvoiceNumberService $numbers, private InvoiceCalculator $calc)
    {
    }

    public function index()
    {
        return response()->json(
            Invoice::with('customer')->latest()->get()->map(fn (Invoice $i) => $this->summary($i))
        );
    }

    public function show(Invoice $invoice)
    {
        return response()->json($this->detail($invoice));
    }

    public function store(Request $request)
    {
        $data = $this->validateData($request);
        $settings = CompanySetting::current();

        $invoice = DB::transaction(function () use ($data, $settings) {
            $inv = Invoice::create($this->mapFields($data, $settings) + [
                'invoice_no' => $this->numbers->next(),
            ]);
            $this->syncLines($inv, $data['line_items'] ?? []);
            $this->calc->recalculate($inv, (float) $settings->default_tax_rate);

            return $inv;
        });

        return response()->json($this->detail($invoice->fresh(['lineItems', 'payments', 'customer'])), 201);
    }

    public function update(Request $request, Invoice $invoice)
    {
        $data = $this->validateData($request);
        $settings = CompanySetting::current();

        DB::transaction(function () use ($data, $invoice, $settings) {
            $invoice->fill($this->mapFields($data, $settings))->save();
            if (array_key_exists('line_items', $data)) {
                $this->syncLines($invoice, $data['line_items']);
            }
            $this->calc->recalculate($invoice, (float) $settings->default_tax_rate);
        });

        return response()->json($this->detail($invoice->fresh(['lineItems', 'payments', 'customer'])));
    }

    public function destroy(Invoice $invoice)
    {
        $invoice->delete();

        return response()->json(['message' => 'Invoice deleted']);
    }

    public function recordPayment(Request $request, Invoice $invoice)
    {
        $data = $request->validate([
            'paid_on' => ['required', 'date'],
            'amount' => ['required', 'numeric', 'min:0.01'],
            'method' => ['nullable', 'string', 'max:50'],
            'reference' => ['nullable', 'string', 'max:100'],
        ]);

        $invoice->payments()->create($data);
        $this->calc->recalculate($invoice, (float) CompanySetting::current()->default_tax_rate);

        return response()->json($this->detail($invoice->fresh(['lineItems', 'payments', 'customer'])));
    }

    /**
     * Generate invoice(s) from a transaction. Only allowed transaction types.
     * Preconstruction → one invoice per commission term; otherwise a single invoice.
     */
    public function generateForTransaction(Transaction $transaction, CommissionService $commissions)
    {
        abort_unless(
            Transaction::isInvoiceableType($transaction->type),
            422,
            'Invoices can only be generated for: '.implode(', ', Transaction::INVOICEABLE_TYPES).'.'
        );

        $settings = CompanySetting::current();
        $transaction->load(['brokerage', 'teamMembers.terms', 'preconTerms']);
        $created = [];

        DB::transaction(function () use ($transaction, $settings, $commissions, &$created) {
            $breakdown = $commissions->breakdown($transaction);

            if ($transaction->type === 'Preconstruction') {
                $terms = $breakdown['terms'] ?? [];
                if (count($terms) === 0) {
                    $created[] = $this->makeFromTransaction($transaction, $settings, null, (float) ($breakdown['master']['commission'] ?? 0));
                } else {
                    foreach ($terms as $term) {
                        $created[] = $this->makeFromTransaction($transaction, $settings, "Term {$term['term_no']}", (float) $term['commission']);
                    }
                }
            } else {
                $created[] = $this->makeFromTransaction($transaction, $settings, null, (float) ($breakdown['commission'] ?? 0));
            }
        });

        return response()->json([
            'count' => count($created),
            'invoices' => array_map(fn (Invoice $i) => $this->summary($i), $created),
        ], 201);
    }

    private function makeFromTransaction(Transaction $t, CompanySetting $settings, ?string $termLabel, float $commission): Invoice
    {
        $b = $t->brokerage;
        $invoiceDate = Carbon::now();
        $suffix = $termLabel ? " — {$termLabel}" : '';

        $invoice = Invoice::create([
            'invoice_no' => $this->numbers->next(),
            'transaction_id' => $t->id,
            'property_reference' => $t->property,
            'customer_name' => $b?->name,
            'customer_address' => $b?->address,
            'customer_country' => 'Canada',
            'invoice_date' => $invoiceDate->toDateString(),
            'terms' => $settings->default_terms,
            'due_date' => optional($this->dueDate($invoiceDate, $settings->default_terms, null))->toDateString(),
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

    public function deletePayment(Invoice $invoice, $paymentId)
    {
        $invoice->payments()->whereKey($paymentId)->delete();
        $this->calc->recalculate($invoice, (float) CompanySetting::current()->default_tax_rate);

        return response()->json($this->detail($invoice->fresh(['lineItems', 'payments', 'customer'])));
    }

    // ---- helpers ----

    private function validateData(Request $request): array
    {
        return $request->validate([
            'transaction_id' => ['nullable', 'integer', 'exists:transactions,id'],
            'property_reference' => ['nullable', 'string', 'max:255'],
            'customer_id' => ['nullable', 'integer', 'exists:customers,id'],
            'customer_name' => ['nullable', 'string', 'max:255'],
            'customer_address' => ['nullable', 'string', 'max:255'],
            'customer_city' => ['nullable', 'string', 'max:255'],
            'customer_province' => ['nullable', 'string', 'max:255'],
            'customer_postal_code' => ['nullable', 'string', 'max:50'],
            'customer_country' => ['nullable', 'string', 'max:100'],
            'invoice_date' => ['required', 'date'],
            'terms' => ['required', 'string', 'max:50'],
            'due_date' => ['nullable', 'date'],
            'trade_number' => ['nullable', 'string', 'max:100'],
            'listing_agent' => ['nullable', 'string', 'max:255'],
            'coop_salesperson' => ['nullable', 'string', 'max:255'],
            'subject' => ['nullable', 'string'],
            'status' => ['nullable', Rule::in(['Draft', 'Unpaid', 'Partially Paid', 'Paid', 'Void'])],
            'line_items' => ['sometimes', 'array'],
            'line_items.*.description' => ['required_with:line_items', 'string', 'max:255'],
            'line_items.*.qty' => ['nullable', 'numeric', 'min:0'],
            'line_items.*.rate' => ['nullable', 'numeric'],
            'line_items.*.is_taxable' => ['nullable', 'boolean'],
        ]);
    }

    private function mapFields(array $data, CompanySetting $settings): array
    {
        $invoiceDate = Carbon::parse($data['invoice_date']);
        $terms = $data['terms'];
        $dueDate = $this->dueDate($invoiceDate, $terms, $data['due_date'] ?? null);

        return [
            'transaction_id' => $data['transaction_id'] ?? null,
            'property_reference' => $data['property_reference'] ?? null,
            'customer_id' => $data['customer_id'] ?? null,
            'customer_name' => $data['customer_name'] ?? null,
            'customer_address' => $data['customer_address'] ?? null,
            'customer_city' => $data['customer_city'] ?? null,
            'customer_province' => $data['customer_province'] ?? null,
            'customer_postal_code' => $data['customer_postal_code'] ?? null,
            'customer_country' => $data['customer_country'] ?? 'Canada',
            'invoice_date' => $invoiceDate->toDateString(),
            'terms' => $terms,
            'due_date' => $dueDate?->toDateString(),
            'trade_number' => $data['trade_number'] ?? null,
            'listing_agent' => $data['listing_agent'] ?? null,
            'coop_salesperson' => $data['coop_salesperson'] ?? null,
            'subject' => $data['subject'] ?? null,
            'status' => $data['status'] ?? 'Draft',
        ];
    }

    private function dueDate(Carbon $invoiceDate, string $terms, ?string $custom): ?Carbon
    {
        if ($terms === 'Custom') {
            return $custom ? Carbon::parse($custom) : null;
        }
        $days = InvoiceCalculator::TERM_DAYS[$terms] ?? null;

        return $days !== null ? $invoiceDate->copy()->addDays($days) : ($custom ? Carbon::parse($custom) : null);
    }

    private function syncLines(Invoice $invoice, array $items): void
    {
        $invoice->lineItems()->delete();
        foreach (array_values($items) as $i => $it) {
            $qty = (float) ($it['qty'] ?? 1);
            $rate = (float) ($it['rate'] ?? 0);
            $invoice->lineItems()->create([
                'row_no' => $i + 1,
                'description' => $it['description'] ?? '',
                'qty' => $qty,
                'rate' => $rate,
                'amount' => round($qty * $rate, 2),
                'is_taxable' => $it['is_taxable'] ?? true,
            ]);
        }
    }

    private function summary(Invoice $i): array
    {
        return [
            'id' => $i->id,
            'invoice_no' => $i->invoice_no,
            'customer_name' => $i->customer_name,
            'property_reference' => $i->property_reference,
            'invoice_date' => optional($i->invoice_date)->toDateString(),
            'due_date' => optional($i->due_date)->toDateString(),
            'total' => (float) $i->total,
            'amount_paid' => (float) $i->amount_paid,
            'balance_due' => (float) $i->balance_due,
            'status' => $i->status,
            'display_status' => $i->displayStatus(),
        ];
    }

    private function detail(Invoice $i): array
    {
        $s = CompanySetting::current();

        return $this->summary($i) + [
            'transaction_id' => $i->transaction_id,
            'customer_id' => $i->customer_id,
            'customer_address' => $i->customer_address,
            'customer_city' => $i->customer_city,
            'customer_province' => $i->customer_province,
            'customer_postal_code' => $i->customer_postal_code,
            'customer_country' => $i->customer_country,
            'terms' => $i->terms,
            'trade_number' => $i->trade_number,
            'listing_agent' => $i->listing_agent,
            'coop_salesperson' => $i->coop_salesperson,
            'subject' => $i->subject,
            'sub_total' => (float) $i->sub_total,
            'tax_total' => (float) $i->tax_total,
            'line_items' => $i->lineItems->map(fn ($l) => [
                'id' => $l->id, 'row_no' => $l->row_no, 'description' => $l->description,
                'qty' => (float) $l->qty, 'rate' => (float) $l->rate, 'amount' => (float) $l->amount,
                'is_taxable' => (bool) $l->is_taxable,
            ]),
            'payments' => $i->payments->map(fn ($p) => [
                'id' => $p->id, 'paid_on' => optional($p->paid_on)->toDateString(),
                'amount' => (float) $p->amount, 'method' => $p->method, 'reference' => $p->reference,
            ]),
            'company' => [
                'name' => $s->name, 'address' => $s->address, 'phone' => $s->phone, 'email' => $s->email,
                'hst_number' => $s->hst_number, 'bank_beneficiary' => $s->bank_beneficiary, 'bank_name' => $s->bank_name,
                'transit_no' => $s->transit_no, 'account_no' => $s->account_no, 'institution_no' => $s->institution_no,
                'currency' => $s->currency, 'tax_rate' => (float) $s->default_tax_rate,
                'thank_you_note' => $s->thank_you_note, 'deposit_heading' => $s->deposit_heading,
            ],
        ];
    }
}
