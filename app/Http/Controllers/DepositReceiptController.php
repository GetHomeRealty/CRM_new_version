<?php

namespace App\Http\Controllers;

use App\Models\Transaction;
use App\Services\AuditService;
use Illuminate\Http\Request;

/**
 * Deposit Receipt actions. The receipt itself is generated client-side (print /
 * PDF); this records the "sent" action against the transaction's audit trail.
 * Actual email dispatch hooks into the email/notifications phase.
 */
class DepositReceiptController extends Controller
{
    public function __construct(private AuditService $audit)
    {
    }

    public function send(Request $request, Transaction $transaction)
    {
        $data = $request->validate([
            'email' => ['required', 'email', 'max:255'],
            'cc' => ['nullable', 'string', 'max:1000'],
        ]);

        $this->audit->record($transaction, [
            'section' => 'Quick Actions — Deposit Receipt',
            'field' => 'Send Deposit Receipt',
            'action' => 'Quick Action executed',
            'source' => 'Quick Action',
            'new' => $data['email'],
            'details' => ! empty($data['cc']) ? 'Cc: '.$data['cc'] : null,
        ]);

        return response()->json(['ok' => true, 'email' => $data['email'], 'cc' => $data['cc'] ?? null]);
    }
}
