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
        if ($transaction->documents()->whereNull('condition_id')->count() === 0) {
            foreach ($this->docs->defaultsFor($transaction->type) as $i => $row) {
                $transaction->documents()->create([
                    'title' => $row['title'],
                    'mandatory' => $row['mandatory'],
                    'position' => $i,
                ]);
            }
        }

        $this->syncConditionDocs($transaction);

        return $this->payload($transaction);
    }

    /** Mirror the transaction's conditions into the checklist as condition rows. */
    private function syncConditionDocs(Transaction $transaction): void
    {
        $conditions = $transaction->conditional_offer ? $transaction->conditions()->get() : collect();
        $existing = $transaction->documents()->whereNotNull('condition_id')->get()->keyBy('condition_id');
        $pos = (int) ($transaction->documents()->max('position') ?? 0);

        foreach ($conditions as $c) {
            $name = $c->custom_name ?: $c->type;
            $title = "Condition: {$name}";
            $doc = $existing->get($c->id);
            if ($doc) {
                if ($doc->title !== $title) {
                    $doc->update(['title' => $title]);
                }
                $existing->forget($c->id);
            } else {
                $transaction->documents()->create([
                    'title' => $title, 'is_condition' => true, 'condition_id' => $c->id, 'position' => ++$pos,
                ]);
            }
        }

        // Drop condition rows whose condition was removed.
        foreach ($existing as $orphan) {
            $this->purgeFiles($orphan);
            $orphan->delete();
        }
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

        // Remove rows deleted client-side (and their files). Condition rows are
        // managed by syncConditionDocs, so they're never removed here.
        $transaction->documents()->whereNull('condition_id')->whereNotIn('id', $keep ?: [0])->get()
            ->each(function (Document $d) {
                $this->purgeFiles($d);
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

    /** §13 — upload a file into a multi-file or per-client document (files JSON). */
    public function uploadDocFile(Request $request, Transaction $transaction, Document $document)
    {
        abort_unless($document->transaction_id === $transaction->id, 404);
        $request->validate(['file' => ['required', 'file', 'max:20480'], 'client_name' => ['nullable', 'string']]);

        $client = $request->input('client_name');
        $files = $document->files ?? [];

        // Per-client: replace the existing file for that client.
        if ($client) {
            foreach ($files as $f) {
                if (($f['client_name'] ?? null) === $client && ! empty($f['file_path'])) {
                    Storage::disk('local')->delete($f['file_path']);
                }
            }
            $files = array_values(array_filter($files, fn ($f) => ($f['client_name'] ?? null) !== $client));
        }

        $file = $request->file('file');
        $files[] = [
            'client_name' => $client,
            'file_name' => $file->getClientOriginalName(),
            'file_path' => $file->store("documents/{$transaction->id}", 'local'),
        ];

        $document->update(['files' => $files, 'status' => 'Received']);

        return $this->payload($transaction->fresh());
    }

    /** Remove one file (by index) from a multi-file / per-client document. */
    public function deleteDocFile(Transaction $transaction, Document $document, int $index)
    {
        abort_unless($document->transaction_id === $transaction->id, 404);
        $files = $document->files ?? [];
        if (isset($files[$index])) {
            if (! empty($files[$index]['file_path'])) {
                Storage::disk('local')->delete($files[$index]['file_path']);
            }
            array_splice($files, $index, 1);
            $document->update(['files' => $files, 'status' => $files ? 'Received' : 'Pending']);
        }

        return $this->payload($transaction->fresh());
    }

    /** §13 — attach supporting evidence for an Invalid validation result. */
    public function uploadValidationFile(Request $request, Transaction $transaction, Document $document)
    {
        abort_unless($document->transaction_id === $transaction->id, 404);
        $request->validate(['file' => ['required', 'file', 'max:20480']]); // 20 MB

        if ($document->validation_file_path) {
            Storage::disk('local')->delete($document->validation_file_path);
        }

        $file = $request->file('file');
        $document->update([
            'validation_file_name' => $file->getClientOriginalName(),
            'validation_file_path' => $file->store("documents/{$transaction->id}", 'local'),
        ]);

        return $this->payload($transaction->fresh());
    }

    /** Remove the validation attachment. */
    public function deleteValidationFile(Transaction $transaction, Document $document)
    {
        abort_unless($document->transaction_id === $transaction->id, 404);
        if ($document->validation_file_path) {
            Storage::disk('local')->delete($document->validation_file_path);
        }
        $document->update(['validation_file_name' => null, 'validation_file_path' => null]);

        return $this->payload($transaction->fresh());
    }

    /** Stream the validation attachment. */
    public function downloadValidationFile(Document $document)
    {
        abort_unless($document->validation_file_path && Storage::disk('local')->exists($document->validation_file_path), 404);

        return Storage::disk('local')->download($document->validation_file_path, $document->validation_file_name);
    }

    /** Stream a document's single file (auth cookie is sent on normal navigation). */
    public function downloadFile(Document $document)
    {
        abort_unless($document->file_path && Storage::disk('local')->exists($document->file_path), 404);

        return Storage::disk('local')->download($document->file_path, $document->file_name);
    }

    /** Stream one file (by index) from a multi-file / per-client document. */
    public function downloadDocFile(Document $document, int $index)
    {
        $f = ($document->files ?? [])[$index] ?? null;
        abort_unless($f && ! empty($f['file_path']) && Storage::disk('local')->exists($f['file_path']), 404);

        return Storage::disk('local')->download($f['file_path'], $f['file_name'] ?? 'download');
    }

    /** Delete every stored file for a document (single + JSON files). */
    private function purgeFiles(Document $d): void
    {
        if ($d->file_path) {
            Storage::disk('local')->delete($d->file_path);
        }
        if ($d->validation_file_path) {
            Storage::disk('local')->delete($d->validation_file_path);
        }
        foreach ($d->files ?? [] as $f) {
            if (! empty($f['file_path'])) {
                Storage::disk('local')->delete($f['file_path']);
            }
        }
    }

    public function destroy(Document $document)
    {
        $this->purgeFiles($document);
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

        $clients = $transaction->clients()->orderBy('position')->pluck('name')->filter()->values();

        return [
            'clients' => $clients,
            'documents' => $docs->map(fn (Document $d) => [
                'id' => $d->id,
                'title' => $d->title,
                'mandatory' => (bool) $d->mandatory,
                'is_condition' => (bool) $d->is_condition,
                'kind' => $d->kind(),
                'deadline' => $d->is_condition ? optional(optional($d->condition)->deadline)->toDateString() : null,
                'status' => $d->status,
                'validation' => $d->validation,
                'remarks' => $d->remarks,
                'file_name' => $d->file_name,
                'has_file' => (bool) $d->file_path,
                'validation_file_name' => $d->validation_file_name,
                'has_validation_file' => (bool) $d->validation_file_path,
                // §13 multi/per-client files
                'files' => collect($d->files ?? [])->values()->map(fn ($f, $idx) => [
                    'index' => $idx,
                    'client_name' => $f['client_name'] ?? null,
                    'file_name' => $f['file_name'] ?? null,
                ]),
                'file_count' => count($d->files ?? []),
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
