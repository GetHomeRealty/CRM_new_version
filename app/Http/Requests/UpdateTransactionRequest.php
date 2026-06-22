<?php

namespace App\Http\Requests;

use App\Models\Transaction;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Full transaction detail save (saveEntireTransaction in the original).
 * Accepts the basic-info fields plus the nested collections handled in
 * the Transactions core slice: statuses, clients, conditions, brokerage,
 * inter-board listings.
 */
class UpdateTransactionRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'type' => ['sometimes', 'string', Rule::in(Transaction::TYPES)],
            'property' => ['sometimes', 'nullable', 'string', 'max:255'],
            'agent' => ['sometimes', 'nullable', 'string', 'max:255'],
            'price' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'deposit' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'offer_date' => ['sometimes', 'nullable', 'date'],
            'closing_date' => ['sometimes', 'nullable', 'date'],
            'listing_contract_date' => ['sometimes', 'nullable', 'date'],
            'listing_expiry_date' => ['sometimes', 'nullable', 'date'],

            'mls_type' => ['sometimes', Rule::in(['mls', 'exclusive'])],
            'mls_num' => ['sometimes', 'nullable', 'string', 'max:255'],
            'mls_verified' => ['sometimes', 'boolean'],

            'comm_type' => ['sometimes', Rule::in(['%', 'Fixed'])],
            'comm_value' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'comm_pct' => ['sometimes', 'nullable', 'numeric', 'min:0', 'max:100'],
            'comm_amt' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'comm_status' => ['sometimes', Rule::in(['Pending', 'Received'])],
            'comm_paid_status' => ['sometimes', 'nullable', Rule::in(['Yes', 'No', 'N/A'])],
            'valid_status' => ['sometimes', Rule::in(['Pending', 'Valid', 'Invalid'])],

            'conditional_offer' => ['sometimes', 'boolean'],
            'inter_board_enabled' => ['sometimes', 'boolean'],

            'statuses' => ['sometimes', 'array'],
            'statuses.*' => ['string'],

            'clients' => ['sometimes', 'array'],
            'clients.*.name' => ['required_with:clients', 'string', 'max:255'],
            'clients.*.email' => ['nullable', 'email', 'max:255'],
            'clients.*.phone' => ['nullable', 'string', 'max:50'],

            'conditions' => ['sometimes', 'array'],
            'conditions.*.type' => ['nullable', 'string', 'max:100'],
            'conditions.*.custom_name' => ['nullable', 'string', 'max:255'],
            'conditions.*.deadline' => ['nullable', 'date'],
            'conditions.*.status' => ['nullable', 'string', 'max:50'],

            'inter_board_listings' => ['sometimes', 'array'],
            'inter_board_listings.*.name' => ['nullable', 'string', 'max:255'],
            'inter_board_listings.*.board_id' => ['nullable', 'string', 'max:255'],
            'inter_board_listings.*.verified' => ['nullable', 'boolean'],

            'brokerage' => ['sometimes', 'nullable', 'array'],
            'brokerage.name' => ['nullable', 'string', 'max:255'],
            'brokerage.address' => ['nullable', 'string', 'max:255'],
            'brokerage.email' => ['nullable', 'email', 'max:255'],
            'brokerage.invoice_email' => ['nullable', 'email', 'max:255'],
            'brokerage.agent_email' => ['nullable', 'email', 'max:255'],
            'brokerage.phone' => ['nullable', 'string', 'max:50'],
            'brokerage.agents' => ['nullable', 'array'],
            'brokerage.agents.*' => ['string', 'max:255'],
        ];
    }
}
