<?php

namespace App\Http\Controllers;

use App\Models\CompanySetting;
use App\Models\Transaction;
use App\Services\AuditService;
use App\Services\TemplateMailService;
use Illuminate\Http\Request;

/**
 * Trade Record Sheet (OREA Form 640) email dispatch. The document itself is
 * rendered client-side; this emails it via the templated mailer and stamps the
 * send so the UI can offer "Resend".
 */
class TradeSheetController extends Controller
{
    public function __construct(private AuditService $audit)
    {
    }

    public function send(Request $request, Transaction $transaction, TemplateMailService $mailer)
    {
        $data = $request->validate([
            'email' => ['required', 'email', 'max:255'],
            'pdf' => ['nullable', 'string'],
            'filename' => ['nullable', 'string', 'max:255'],
        ]);

        $resend = (bool) $transaction->trade_sheet_sent_at;
        $attachments = ! empty($data['pdf'])
            ? [['data' => $data['pdf'], 'name' => $data['filename'] ?? "Trade Record Sheet {$transaction->trade_no}.pdf", 'mime' => 'application/pdf']]
            : [];

        try {
            $mailer->send('trade_sheet.send', [
                'transaction_number' => $transaction->trade_no,
                'property_address' => $transaction->property,
                'agent_name' => $transaction->agent,
                'company_name' => CompanySetting::current()->name,
            ], $data['email'], $transaction->agentEmails(), $attachments);
        } catch (\Throwable $e) {
            return response()->json(['ok' => false, 'message' => 'Send failed: '.$e->getMessage()], 422);
        }

        $transaction->update(['trade_sheet_sent_at' => now()]);

        $this->audit->record($transaction, [
            'section' => 'Quick Actions — Trade Record Sheet',
            'field' => 'Trade Record Sheet',
            'action' => $resend ? 'Resent' : 'Sent',
            'source' => 'Quick Action',
            'new' => $data['email'],
        ]);

        return response()->json([
            'ok' => true,
            'message' => ($resend ? 'Resent' : 'Sent').' to '.$data['email'],
            'sent_at' => $transaction->trade_sheet_sent_at?->toIso8601String(),
        ]);
    }
}
