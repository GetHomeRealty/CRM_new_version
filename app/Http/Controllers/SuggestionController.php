<?php

namespace App\Http\Controllers;

use App\Models\Brokerage;
use App\Models\Transaction;

/**
 * Type-ahead suggestions sourced from previously saved records, so staff can
 * reuse lawyer / brokerage details entered on earlier transactions instead of
 * retyping them. Read-only; available to any authenticated user.
 */
class SuggestionController extends Controller
{
    /** Distinct lawyers previously entered (latest values win), newest first. */
    public function lawyers()
    {
        $rows = Transaction::query()
            ->whereNotNull('lawyer_name')->where('lawyer_name', '!=', '')
            ->orderByDesc('id')
            ->get(['lawyer_name', 'lawyer_email', 'lawyer_phone', 'lawyer_address']);

        return response()->json($this->dedupe($rows, 'lawyer_name', fn ($r) => [
            'name' => $r->lawyer_name,
            'email' => $r->lawyer_email,
            'phone' => $r->lawyer_phone,
            'address' => $r->lawyer_address,
        ]));
    }

    /** Distinct brokerages previously entered (with their agent names), newest first. */
    public function brokerages()
    {
        $rows = Brokerage::query()
            ->whereNotNull('name')->where('name', '!=', '')
            ->with('agents')
            ->orderByDesc('id')->get();

        return response()->json($this->dedupe($rows, 'name', fn ($b) => [
            'name' => $b->name,
            'address' => $b->address,
            'email' => $b->email,
            'invoice_email' => $b->invoice_email,
            'agent_email' => $b->agent_email,
            'phone' => $b->phone,
            'agents' => $b->agents->pluck('name')->filter()->values(),
        ]));
    }

    /** Keep the first (newest) row per case-insensitive key value. */
    private function dedupe($rows, string $keyField, callable $map): array
    {
        $seen = [];
        $out = [];
        foreach ($rows as $row) {
            $key = mb_strtolower(trim((string) $row->{$keyField}));
            if ($key === '' || isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $out[] = $map($row);
        }

        return $out;
    }
}
