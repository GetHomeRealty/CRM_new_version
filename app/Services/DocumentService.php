<?php

namespace App\Services;

/**
 * Type-specific default document checklists. Ported verbatim from getDocList()
 * in the original app.js — each entry is [title, mandatory].
 */
class DocumentService
{
    /** @return array<int, array{title:string, mandatory:bool}> */
    public function defaultsFor(string $type): array
    {
        $t = strtolower($type);

        if ($t === 'referral') {
            return $this->rows([
                ['Referral doc', true],
                ['Notice of Sale', false],
                ['Trade Sheet', false],
            ]);
        }

        if ($t === 'preconstruction') {
            return $this->rows([
                ['Agreement of Purchase and Sale (APS)', true],
                ['Broker Referral', true],
                ['Deposit Slip', false],
                ['Trade Sheet', false],
            ]);
        }

        if (str_contains($t, 'listing')) {
            $isLeaseListing = str_contains($t, 'lease');

            return $this->rows([
                ['Listing agreement', true],
                ['MLS data sheet', true],
                ['Client Photo IDs', false],
                ['FINTRAC', false],
                ['Offer Summary Document', false],
                [$isLeaseListing ? 'Agreement to Lease' : 'Agreement of Purchase & Sale', false],
                ['Confirmation of CO-OP', false],
                ['Schedule B', false],
                ['Deposit Receipt', false],
                ['MLS', false],
            ]);
        }

        // Deal-side lease (Residential Lease, Commercial Property Lease).
        if (str_contains($t, 'lease')) {
            return $this->rows([
                ['Offer Summary', false],
                ['Agreement to Lease', true],
                ['Schedule B', false],
                ['Confirmation of CO-OP', true],
                ['Tenant Representation', true],
                ['ORTA', false],
                ['Deposit Receipt', true],
                ['Client Photo IDs', false],
                ['FINTRAC', false],
            ]);
        }

        // Deal-side buying (Residential Buying, Commercial Property Buying, Business Buying).
        if (str_contains($t, 'buy')) {
            return $this->rows([
                ['Offer Summary', false],
                ['Agreement of Purchase and Sale', true],
                ['Schedule B', false],
                ['Confirmation of CO-OP', true],
                ['Buyer Representation', true],
                ['Deposit Receipt', true],
                ['MLS', false],
                ['Client Photo IDs', false],
                ['FINTRAC', false],
            ]);
        }

        // Business Sale and anything else: no preset checklist.
        return [];
    }

    /** @return array<int, array{title:string, mandatory:bool}> */
    private function rows(array $pairs): array
    {
        // Documents are no longer flagged mandatory (removed across all types/statuses).
        return array_map(fn ($p) => ['title' => $p[0], 'mandatory' => false], $pairs);
    }
}
