<?php

namespace App\Http\Controllers;

use App\Models\Document;
use App\Models\Transaction;
use App\Services\DocumentService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;

class DocumentController extends Controller
{
    public function __construct(private DocumentService $docs)
    {
    }

    /** Document list for a transaction; seeds the type-specific defaults on first access. */
    public function index(Transaction $transaction)
    {
        if ($transaction->documents()->count() === 0) {
            foreach ($this->docs->defaultsFor($transaction->type) as $i => $row) {
                $transaction->documents()->create([
                    'title' => $row['title'],
                    'mandatory' => $row['mandatory'],
                    'position' => $i,
                ]);
            }
        }

        return $this->payload($transaction);
    }

    /** Bulk save the checklist (status / validation / remarks / add / remove). */
    public function bulkUpdate(Request $request, Transaction $transaction)
    {
        $data = $request->validate([
            'documents' => ['present', 'array'],
            'documents.*.id' => ['nullable', 'integer'],
            'documents.*.title' => ['required', 'string', 'max:255'],
            'documents.*.mandatory' => ['nullable', 'boolean'],
            'documents.*.status' => ['nullable', 'in:Pending,Received'],
            'documents.*.validation' => ['nullable', 'in:Pending,Valid,Invalid'],
            'documents.*.remarks' => ['nullable', 'string'],
        ]);

        $keep = [];
        foreach (array_values($data['documents']) as $i => $row) {
            $attrs = [
                'title' => $row['title'],
                'mandatory' => (bool) ($row['mandatory'] ?? false),
                'status' => $row['status'] ?? 'Pending',
                'validation' => $row['validation'] ?? 'Pending',
                'remarks' => $row['remarks'] ?? null,
                'position' => $i,
            ];
            $existing = ! empty($row['id']) ? $transaction->documents()->find($row['id']) : null;
            if ($existing) {
                $existing->update($attrs);
                $keep[] = $existing->id;
            } else {
                $keep[] = $transaction->documents()->create($attrs)->id;
            }
        }

        // Remove rows that were deleted client-side (and their files).
        $transaction->documents()->whereNotIn('id', $keep ?: [0])->get()->each(function (Document $d) {
            if ($d->file_path) {
                Storage::disk('local')->delete($d->file_path);
            }
            $d->delete();
        });

        return $this->payload($transaction->fresh());
    }

    /** Upload a file for a document → marks it Received. */
    public function uploadFile(Request $request, Transaction $transaction, Document $document)
    {
        abort_unless($document->transaction_id === $transaction->id, 404);
        $request->validate(['file' => ['required', 'file', 'max:20480']]); // 20 MB

        if ($document->file_path) {
            Storage::disk('local')->delete($document->file_path);
        }

        $file = $request->file('file');
        $path = $file->store("documents/{$transaction->id}", 'local');

        $document->update([
            'file_name' => $file->getClientOriginalName(),
            'file_path' => $path,
            'status' => 'Received',
        ]);

        return $this->payload($transaction->fresh());
    }

    /** Stream a document's file (auth cookie is sent on normal navigation). */
    public function downloadFile(Document $document)
    {
        abort_unless($document->file_path && Storage::disk('local')->exists($document->file_path), 404);

        return Storage::disk('local')->download($document->file_path, $document->file_name);
    }

    public function destroy(Document $document)
    {
        if ($document->file_path) {
            Storage::disk('local')->delete($document->file_path);
        }
        $document->delete();

        return response()->json(['message' => 'Document deleted']);
    }

    private function payload(Transaction $transaction): array
    {
        $docs = $transaction->documents()->orderBy('position')->get();
        $total = $docs->count();
        $mandatory = $docs->where('mandatory', true)->count();
        $received = $docs->where('status', 'Received')->count();
        $pending = $total - $received;

        return [
            'documents' => $docs->map(fn (Document $d) => [
                'id' => $d->id,
                'title' => $d->title,
                'mandatory' => (bool) $d->mandatory,
                'is_condition' => (bool) $d->is_condition,
                'status' => $d->status,
                'validation' => $d->validation,
                'remarks' => $d->remarks,
                'file_name' => $d->file_name,
                'has_file' => (bool) $d->file_path,
            ])->values(),
            'stats' => [
                'total' => $total,
                'mandatory' => $mandatory,
                'received' => $received,
                'pending' => $pending,
                'pct' => $total > 0 ? (int) round($received / $total * 100) : 0,
            ],
        ];
    }
}
