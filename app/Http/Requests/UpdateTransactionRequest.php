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
            'comm_adjust_enabled' => ['sometimes', 'boolean'],
            'comm_adjust_before' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'comm_adjust_after' => ['sometimes', 'nullable', 'numeric', 'min:0'],

            'listing_comm_pct' => ['sometimes', 'nullable', 'numeric', 'min:0', 'max:100'],
            'coop_comm_pct' => ['sometimes', 'nullable', 'numeric', 'min:0', 'max:100'],
            'listing_adj_enabled' => ['sometimes', 'boolean'],
            'listing_adj_before' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'listing_adj_after' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'coop_adj_enabled' => ['sometimes', 'boolean'],
            'coop_adj_before' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'coop_adj_after' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'comm_status' => ['sometimes', Rule::in(['Pending', 'Received'])],
            'comm_paid_status' => ['sometimes', 'nullable', Rule::in(['Yes', 'No', 'N/A'])],
            'valid_status' => ['sometimes', Rule::in(['Pending', 'Valid', 'Invalid'])],

            'precon_listing_type' => ['sometimes', Rule::in(['mls', 'builder'])],
            'precon_term_count' => ['sometimes', 'nullable', 'integer', 'min:0', 'max:200'],
            'commission_agent' => ['sometimes', 'nullable', 'string', 'max:255'],
            'precon_net_of_hst' => ['sometimes', 'boolean'],
            'precon_comm_pct' => ['sometimes', 'nullable', 'numeric', 'min:0', 'max:100'],
            'precon_comm_amt_manual' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'precon_details_of_terms' => ['sometimes', 'nullable', 'string', 'max:50'],
            'builder' => ['sometimes', 'nullable', 'array'],
            'builder.name' => ['nullable', 'string', 'max:255'],
            'builder.vendor' => ['nullable', 'string', 'max:255'],
            'builder.project' => ['nullable', 'string', 'max:255'],
            'builder.address' => ['nullable', 'string', 'max:255'],
            'builder.office_email' => ['nullable', 'email', 'max:255'],
            'builder.invoice_email' => ['nullable', 'email', 'max:255'],
            'builder.phone' => ['nullable', 'string', 'max:50'],
            'precon_terms' => ['sometimes', 'array'],
            'precon_terms.*.term_no' => ['required_with:precon_terms', 'integer', 'min:1'],
            'precon_terms.*.pct' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'precon_terms.*.closing_date' => ['nullable', 'date'],

            'team' => ['sometimes', 'array'],
            'team.*.name' => ['required_with:team', 'string', 'max:255'],
            'team.*.split' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'team.*.agent_pct' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'team.*.brok_pct' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'team.*.is_primary' => ['nullable', 'boolean'],
            'team.*.scope' => ['nullable', Rule::in(['Entire', 'Particular'])],
            'team.*.terms' => ['nullable', 'array'],
            'team.*.terms.*' => ['integer', 'min:1'],

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
