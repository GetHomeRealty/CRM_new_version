<?php

namespace App\Http\Controllers;

use App\Models\CompanySetting;
use App\Models\Invoice;
use App\Models\Transaction;
use App\Services\InvoiceCalculator;
use App\Services\InvoiceNumberService;
use App\Services\TransactionInvoiceService;
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
        $userId = $request->user()?->id;

        $invoice = DB::transaction(function () use ($data, $settings, $userId) {
            $inv = Invoice::create($this->mapFields($data, $settings) + [
                'invoice_no' => $this->numbers->next(),
                'source' => 'manual',
                'created_by' => $userId,
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
    public function generateForTransaction(Transaction $transaction, TransactionInvoiceService $generator)
    {
        abort_unless(
            Transaction::isInvoiceableType($transaction->type),
            422,
            'Invoices can only be generated for: '.implode(', ', Transaction::INVOICEABLE_TYPES).'.'
        );

        // Dedup: if invoices already exist for this transaction, return them
        // (the UI shows "View Invoice") instead of creating duplicates.
        $existing = $transaction->invoices()->get();
        if ($existing->isNotEmpty()) {
            return response()->json([
                'count' => 0,
                'existing' => true,
                'invoices' => $existing->map(fn (Invoice $i) => $this->summary($i)),
            ]);
        }

        $created = $generator->generate($transaction);

        return response()->json([
            'count' => count($created),
            'existing' => false,
            'invoices' => array_map(fn (Invoice $i) => $this->summary($i), $created),
        ], 201);
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
            'customer_phone' => ['nullable', 'string', 'max:50'],
            'customer_email' => ['nullable', 'string', 'max:500'],
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
            'discount' => ['nullable', 'numeric', 'min:0'],
            'customer_notes' => ['nullable', 'string'],
            'terms_conditions' => ['nullable', 'string'],
            'signature_path' => ['nullable', 'string'],
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
            'customer_phone' => $data['customer_phone'] ?? null,
            'customer_email' => $data['customer_email'] ?? null,
            'discount' => $data['discount'] ?? 0,
            'customer_notes' => $data['customer_notes'] ?? null,
            'terms_conditions' => $data['terms_conditions'] ?? null,
            'signature_path' => $data['signature_path'] ?? null,
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
            // Origin markers (transaction-generated vs manual).
            'source' => $i->source ?? 'manual',
            'transaction_id' => $i->transaction_id,
            'transaction_type' => $i->transaction_type,
            'trade_number' => $i->trade_number,
            'listing_agent' => $i->listing_agent,
        ];
    }

    private function detail(Invoice $i): array
    {
        $s = CompanySetting::current();

        // Fall back to the transaction's Listing/Co-op Brokerage Information + agent for
        // any field left blank (so transaction-linked invoices show the saved data).
        $txn = $i->transaction;
        $brok = optional($txn)->brokerage;
        $brokEmails = $brok ? array_values(array_unique(array_filter([$brok->invoice_email, $brok->email, $brok->agent_email]))) : [];
        $brokAgents = $brok ? $brok->agents->pluck('name')->filter()->implode(', ') : null;

        return array_merge($this->summary($i), [
            'transaction_id' => $i->transaction_id,
            'purchase_price' => $i->transaction_id ? (float) optional($txn)->price : null,
            'customer_id' => $i->customer_id,
            'customer_name' => $i->customer_name ?: ($brok->name ?? null),
            'customer_phone' => $i->customer_phone ?: ($brok->phone ?? null),
            'customer_email' => $i->customer_email ?: implode(', ', $brokEmails),
            'customer_address' => $i->customer_address ?: ($brok->address ?? null),
            // Co-op salesperson = the GHR agent on the deal; Listing agent = the other brokerage's agent(s).
            'coop_salesperson' => $i->coop_salesperson ?: (optional($txn)->agent),
            'listing_agent' => $i->listing_agent ?: ($brokAgents ?: optional($txn)->agent),
            'customer_city' => $i->customer_city,
            'customer_province' => $i->customer_province,
            'customer_postal_code' => $i->customer_postal_code,
            'customer_country' => $i->customer_country,
            'discount' => (float) $i->discount,
            'customer_notes' => $i->customer_notes,
            'terms_conditions' => $i->terms_conditions,
            'signature_path' => $i->signature_path,
            'terms' => $i->terms,
            'trade_number' => $i->trade_number,
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
        ]);
    }
}
