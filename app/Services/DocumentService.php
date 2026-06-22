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

        if (str_contains($t, 'commercial property') || str_starts_with($t, 'business ')) {
            return [];
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

        if (str_contains($t, 'residential buy')) {
            return $this->rows([
                ['801 (Offer Summary)', false],
                ['100 (Agreement of Purchase and Sale)', true],
                ['105 (Schedule B)', false],
                ['320 (Confirmation of CO-OP)', true],
                ['300 (Buyer Representation)', true],
                ['Deposit Receipt', true],
                ['MLS', false],
                ['Client Photo IDs', false],
                ['FINTRAC', false],
            ]);
        }

        if (str_contains($t, 'lease')) {
            return $this->rows([
                ['801 (Offer Summary)', false],
                ['400 (Agreement to Lease)', true],
                ['401 (Schedule B)', false],
                ['324 (Confirmation of CO-OP)', true],
                ['346 (Tenant Representation)', true],
                ['ORTA', false],
                ['Deposit Receipt', true],
                ['Client Photo IDs', false],
                ['FINTRAC', false],
            ]);
        }

        return $this->rows([
            ['Schedule B', false],
            ['Confirmation of CO-OP', true],
            ['Representation Agreement', true],
            ['Deposit Receipt', true],
            ['Client Photo IDs', false],
            ['FINTRAC', false],
        ]);
    }

    /** @return array<int, array{title:string, mandatory:bool}> */
    private function rows(array $pairs): array
    {
        return array_map(fn ($p) => ['title' => $p[0], 'mandatory' => $p[1]], $pairs);
    }
}
