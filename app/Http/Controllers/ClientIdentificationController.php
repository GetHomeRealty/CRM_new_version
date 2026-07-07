<?php

namespace App\Http\Controllers;

use App\Models\ClientIdentification;
use App\Models\Transaction;
use App\Services\IdExtractionService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;

/**
 * Per-client FINTRAC identity record for Form 630 — extracted from the uploaded
 * photo ID (review-before-save) and persisted encrypted, one row per client.
 */
class ClientIdentificationController extends Controller
{
    private const FIELDS = [
        'full_legal_name', 'address', 'dob', 'occupation',
        'id_type', 'id_number', 'issuing_jurisdiction', 'country', 'expiry_date',
    ];

    /** Agents may only touch identifications on transactions they own or split into. */
    private function guard(Request $request, Transaction $t): void
    {
        $u = $request->user();
        if ($u && $u->role === 'agent') {
            $allowed = $t->agent === $u->name || $t->teamMembers()->where('name', $u->name)->exists();
            abort_unless($allowed, 403, 'You do not have access to this transaction.');
        }
    }

    private function record(Transaction $t, string $client): ClientIdentification
    {
        return ClientIdentification::firstOrNew(['transaction_id' => $t->id, 'client_name' => $client]);
    }

    /** Stored identification for a client (null fields if none yet). */
    public function show(Request $request, Transaction $transaction)
    {
        $this->guard($request, $transaction);
        $data = $request->validate(['client_name' => ['required', 'string']]);
        $rec = ClientIdentification::where('transaction_id', $transaction->id)
            ->where('client_name', $data['client_name'])->first();

        return response()->json($this->present($rec, $data['client_name']));
    }

    /** Save reviewed/edited identity data (marks the record verified). */
    public function update(Request $request, Transaction $transaction)
    {
        $this->guard($request, $transaction);
        $data = $request->validate([
            'client_name' => ['required', 'string'],
            'full_legal_name' => ['nullable', 'string'],
            'address' => ['nullable', 'string'],
            'dob' => ['nullable', 'string'],
            'occupation' => ['nullable', 'string'],
            'id_type' => ['nullable', 'string'],
            'id_number' => ['nullable', 'string'],
            'issuing_jurisdiction' => ['nullable', 'string'],
            'country' => ['nullable', 'string'],
            'expiry_date' => ['nullable', 'string'],
            'verified' => ['nullable', 'boolean'],
        ]);

        $rec = $this->record($transaction, $data['client_name']);
        foreach (self::FIELDS as $f) {
            $rec->$f = $data[$f] ?? null;
        }
        $rec->source = 'manual';
        $rec->verified = (bool) ($data['verified'] ?? $rec->verified);
        $rec->save();

        return response()->json($this->present($rec->fresh(), $data['client_name']));
    }

    /**
     * Run extraction on the client's uploaded photo ID and fill ONLY currently-empty
     * fields (never clobber values a human already entered/verified).
     */
    public function extract(Request $request, Transaction $transaction, IdExtractionService $extractor)
    {
        $this->guard($request, $transaction);
        $data = $request->validate([
            'client_name' => ['required', 'string'],
            'document_id' => ['required', 'integer'],
        ]);

        $document = $transaction->documents()->find($data['document_id']);
        abort_unless($document, 404, 'Document not found.');

        $file = collect($document->files ?? [])->first(
            fn ($f) => ($f['client_name'] ?? null) === $data['client_name'] && ! empty($f['file_path'])
        );
        if (! $file || ! Storage::disk('local')->exists($file['file_path'])) {
            return response()->json(['ok' => false, 'message' => 'No uploaded ID file found for this client.'], 422);
        }

        $contents = Storage::disk('local')->get($file['file_path']);
        $mime = Storage::disk('local')->mimeType($file['file_path']) ?: 'application/octet-stream';

        $result = $extractor->extractIdFields($contents, $mime);
        $existing = ClientIdentification::where('transaction_id', $transaction->id)
            ->where('client_name', $data['client_name'])->first();

        if (! $result['configured']) {
            return response()->json([
                'ok' => false, 'configured' => false,
                'message' => 'ID auto-extraction is not configured — enter the details manually.',
                'identification' => $this->present($existing, $data['client_name']),
            ]);
        }

        $rec = $this->record($transaction, $data['client_name']);
        $isNew = ! $rec->exists;
        $filled = 0;
        foreach ($result['fields'] as $k => $val) {
            if ($val !== null && ($rec->$k === null || $rec->$k === '')) {
                $rec->$k = $val;
                $filled++;
            }
        }
        if ($isNew) {
            $rec->source = 'extracted';
            $rec->verified = false;
        }
        $rec->extracted_at = now();
        $rec->save();

        return response()->json([
            'ok' => $result['ok'],
            'configured' => true,
            'filled' => $filled,
            'message' => $result['ok']
                ? ($filled ? "Extracted {$filled} field(s) from the ID — review and confirm in Form 630." : 'No new fields extracted (existing values kept).')
                : 'Could not read the ID clearly — enter the details manually.',
            'identification' => $this->present($rec->fresh(), $data['client_name']),
        ]);
    }

    private function present(?ClientIdentification $rec, string $client): array
    {
        $out = [
            'client_name' => $client,
            'source' => $rec?->source,
            'verified' => (bool) ($rec?->verified),
            'extracted_at' => optional($rec?->extracted_at)->toIso8601String(),
        ];
        foreach (self::FIELDS as $f) {
            $out[$f] = $rec?->$f;
        }

        return $out;
    }
}
