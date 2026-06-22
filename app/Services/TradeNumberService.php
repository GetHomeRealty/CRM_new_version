<?php

namespace App\Services;

use App\Models\Transaction;

/**
 * Generates the next trade number for a transaction type.
 *
 * Ported from getNextTradeNumber() in the original app.js:
 *  - Residential Buying : 1–99,    zero-padded to 3 digits ("001")
 *  - Residential Lease  : 100–999, zero-padded to 3 digits ("100")
 *  - everything else    : legacy integers starting at 200836 (no padding)
 */
class TradeNumberService
{
    public function next(string $type): string
    {
        [$start, $useLegacy, $matches] = $this->rulesFor($type);

        $used = Transaction::query()
            ->pluck('trade_no')
            ->filter(fn ($id) => $matches($id))
            ->map(fn ($id) => (int) $id)
            ->flip();

        $candidate = $start;
        while ($used->has($candidate)) {
            $candidate++;
        }

        return $useLegacy ? (string) $candidate : str_pad((string) $candidate, 3, '0', STR_PAD_LEFT);
    }

    /** @return array{0:int,1:bool,2:callable} */
    private function rulesFor(string $type): array
    {
        if ($type === 'Residential Buying') {
            return [1, false, fn ($id) => preg_match('/^\d{1,3}$/', (string) $id) && (int) $id >= 1 && (int) $id < 100];
        }

        if ($type === 'Residential Lease') {
            return [100, false, fn ($id) => preg_match('/^\d{1,3}$/', (string) $id) && (int) $id >= 100 && (int) $id <= 999];
        }

        return [200836, true, fn ($id) => (int) $id >= 200000];
    }
}
