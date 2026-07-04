<?php

namespace App\Http\Controllers;

use App\Models\CompanySetting;
use App\Models\Transaction;
use App\Services\AuditService;
use App\Services\TemplateMailService;
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

        // Email the deposit receipt via the templated mailer (non-blocking). The
        // typed Cc addresses and the deal's agents are all CC'd.
        $cc = array_merge(
            preg_split('/[,;\s]+/', (string) ($data['cc'] ?? ''), -1, PREG_SPLIT_NO_EMPTY) ?: [],
            $transaction->agentEmails(),
        );
        try {
            app(TemplateMailService::class)->send('deposit_receipt.send', [
                'transaction_number' => $transaction->trade_no,
                'deposit_amount' => number_format((float) $transaction->deposit, 2),
                'property_address' => $transaction->property,
                'company_name' => CompanySetting::current()->name,
            ], $data['email'], $cc);
        } catch (\Throwable $e) {
            report($e);
        }

        return response()->json(['ok' => true, 'email' => $data['email'], 'cc' => $data['cc'] ?? null]);
    }
}
