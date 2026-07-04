<?php

namespace App\Http\Requests;

use App\Models\Transaction;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreTransactionRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        $isListing = Transaction::isListingType($this->input('type'));

        $rules = [
            'type' => ['required', 'string', Rule::in(Transaction::TYPES)],
            'property' => ['required', 'string', 'max:255'],
            // Status is chosen at creation (mandatory in the Add modal).
            'status' => ['required', 'string', 'max:50'],
            // Team option: primary agent (Agent 1) + involved team members. Split %
            // is filled in later under Team Split, so only names are captured here.
            'primary_agent' => ['nullable', 'string', 'max:255'],
            'team_members' => ['nullable', 'array'],
            'team_members.*' => ['string', 'max:255'],
        ];

        if ($isListing) {
            $rules += [
                'listing_contract_date' => ['nullable', 'date'],
                'listing_expiry_date' => ['nullable', 'date'],
            ];
        } else {
            // Buying / lease / precon / referral path of the Add modal.
            $rules += [
                'comm_type' => ['required', Rule::in(['%', 'Fixed'])],
                'comm_value' => ['required', 'numeric', 'min:0'],
                'price' => ['required', 'numeric', 'min:0'],
                'deposit' => ['nullable', 'numeric', 'min:0'],
                'offer_date' => ['required', 'date'],
                'closing_date' => ['required', 'date'],
            ];

            if ($this->input('comm_type') === '%') {
                $rules['comm_value'][] = 'max:100';
            }
        }

        return $rules;
    }
}
