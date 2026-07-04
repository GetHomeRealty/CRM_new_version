<?php

namespace App\Http\Controllers;

use App\Models\Transaction;
use App\Services\AuditService;
use Illuminate\Http\Request;

/**
 * Notice of Sale editable data — buyer / seller name overrides, document date,
 * and per-salesperson signatures (stored inline as data URIs) plus send/sign
 * timestamps. Persisted in the transaction's notice_of_sale JSON column.
 */
class NoticeOfSaleController extends Controller
{
    public function __construct(private AuditService $audit)
    {
    }

    private const SECTION = 'Quick Actions — Notice of Sale';

    /** Current saved Notice of Sale data (empty object if never edited). */
    public function show(Transaction $transaction)
    {
        return response()->json($this->present($this->normalize($transaction->notice_of_sale)));
    }

    /** Save buyer/seller names, the document date, and any uploaded signatures. */
    public function save(Request $request, Transaction $transaction)
    {
        $data = $request->validate([
            'buyers' => ['present', 'array'],
            'buyers.*' => ['nullable', 'string', 'max:255'],
            'sellers' => ['present', 'array'],
            'sellers.*' => ['nullable', 'string', 'max:255'],
            'date' => ['nullable', 'string', 'max:20'],
            'agents' => ['nullable', 'array'],
            'agents.*.signature' => ['nullable', 'string', 'max:8000000'], // data URI (~6 MB image)
            'agents.*.signed_date' => ['nullable', 'string', 'max:20'],
        ]);

        $previous = $this->normalize($transaction->notice_of_sale);
        $current = $previous;

        $current['buyers'] = array_values(array_filter(array_map('trim', $data['buyers']), fn ($v) => $v !== ''));
        $current['sellers'] = array_values(array_filter(array_map('trim', $data['sellers']), fn ($v) => $v !== ''));
        $current['date'] = $data['date'] ?? $current['date'] ?? null;

        // Merge agent signatures, preserving any existing sent_at stamps.
        foreach ($data['agents'] ?? [] as $name => $row) {
            $existing = $current['agents'][$name] ?? [];
            $current['agents'][$name] = [
                'signature' => $row['signature'] ?? ($existing['signature'] ?? null),
                'signed_date' => $row['signed_date'] ?? ($existing['signed_date'] ?? null),
                'sent_at' => $existing['sent_at'] ?? null,
            ];
        }

        // Audit meaningful changes (buyers / sellers / new signatures).
        $prevBuyers = implode(', ', $previous['buyers'] ?? []);
        $prevSellers = implode(', ', $previous['sellers'] ?? []);
        if (implode(', ', $current['buyers']) !== $prevBuyers) {
            $this->audit->record($transaction, ['section' => self::SECTION, 'field' => 'Buyers', 'action' => 'Updated', 'source' => 'Quick Action', 'old' => $prevBuyers, 'new' => implode(', ', $current['buyers'])]);
        }
        if (implode(', ', $current['sellers']) !== $prevSellers) {
            $this->audit->record($transaction, ['section' => self::SECTION, 'field' => 'Sellers', 'action' => 'Updated', 'source' => 'Quick Action', 'old' => $prevSellers, 'new' => implode(', ', $current['sellers'])]);
        }
        foreach ($data['agents'] ?? [] as $name => $row) {
            $hadSig = ! empty(($previous['agents'][$name] ?? [])['signature']);
            $hasSig = ! empty($current['agents'][$name]['signature']);
            if ($hasSig && ! $hadSig) {
                $this->audit->record($transaction, ['section' => self::SECTION, 'field' => "Signature — {$name}", 'action' => 'Document uploaded', 'source' => 'Quick Action']);
            } elseif (! $hasSig && $hadSig) {
                $this->audit->record($transaction, ['section' => self::SECTION, 'field' => "Signature — {$name}", 'action' => 'Document deleted', 'source' => 'Quick Action']);
            }
        }

        $transaction->update(['notice_of_sale' => $current]);

        return response()->json($this->present($this->normalize($transaction->fresh()->notice_of_sale)));
    }

    /** Mark the Notice as sent to the given salespersons (Send / per-agent Resend). */
    public function send(Request $request, Transaction $transaction)
    {
        $data = $request->validate([
            'agents' => ['present', 'array'],
            'agents.*' => ['string', 'max:255'],
        ]);

        $current = $this->normalize($transaction->notice_of_sale);
        $now = now()->toIso8601String();
        $current['sent_at'] = $now;

        foreach ($data['agents'] as $name) {
            $existing = $current['agents'][$name] ?? ['signature' => null, 'signed_date' => null];
            $existing['sent_at'] = $now;
            $current['agents'][$name] = $existing;
        }

        $transaction->update(['notice_of_sale' => $current]);

        $this->audit->record($transaction, [
            'section' => self::SECTION, 'field' => 'Send for signature', 'action' => 'Quick Action executed',
            'source' => 'Quick Action', 'new' => implode(', ', $data['agents']),
        ]);

        return response()->json($this->present($this->normalize($transaction->fresh()->notice_of_sale)));
    }

    /** Guarantee a stable array shape regardless of what's stored. */
    private function normalize($notice): array
    {
        $notice = is_array($notice) ? $notice : [];

        return [
            'buyers' => array_values($notice['buyers'] ?? []),
            'sellers' => array_values($notice['sellers'] ?? []),
            'date' => $notice['date'] ?? null,
            'sent_at' => $notice['sent_at'] ?? null,
            'agents' => (array) ($notice['agents'] ?? []),
        ];
    }

    /** Cast agents to an object so it serializes as a JSON map (even when empty). */
    private function present(array $n): array
    {
        $n['agents'] = (object) $n['agents'];

        return $n;
    }
}
