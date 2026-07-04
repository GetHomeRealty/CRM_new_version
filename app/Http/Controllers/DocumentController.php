<?php

namespace App\Http\Controllers;

use App\Models\Document;
use App\Models\Transaction;
use App\Services\AuditService;
use App\Services\DocsValidationService;
use App\Services\DocumentService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;

class DocumentController extends Controller
{
    public function __construct(
        private DocumentService $docs,
        private AuditService $audit,
        private DocsValidationService $docsValidation,
    ) {
    }

    private const SECTION = 'Legal & Documents';

    /** A document the agent marked "Not Accepted" cannot receive uploads. */
    private function guardAccepted(Document $document): void
    {
        abort_if(
            $document->agent_accepted === 'Not Accepted',
            422,
            'This document was marked "Not Accepted" — uploads are disabled for it.'
        );
    }

    /** Agents may only touch documents on transactions they own or are split into. */
    private function guardAgent(Request $request, Transaction $transaction): void
    {
        $u = $request->user();
        if ($u && $u->role === 'agent') {
            $name = $u->name;
            $allowed = $transaction->agent === $name || $transaction->teamMembers()->where('name', $name)->exists();
            abort_unless($allowed, 403, 'You do not have access to this transaction.');
        }
    }

    /** Document list for a transaction; seeds the type-specific defaults on first access. */
    public function index(Request $request, Transaction $transaction)
    {
        $this->guardAgent($request, $transaction);

        if ($transaction->documents()->whereNull('condition_id')->count() === 0) {
            foreach ($this->docs->defaultsFor($transaction->type) as $i => $row) {
                $transaction->documents()->create([
                    'title' => $row['title'],
                    'mandatory' => $row['mandatory'],
                    'position' => $i,
                ]);
            }
        }

        // Documents are no longer mandatory — clear the flag on any existing rows.
        $transaction->documents()->where('mandatory', true)->update(['mandatory' => false]);

        $this->stripFormNumberPrefixes($transaction);
        $this->ensureStatusDocs($transaction);
        $this->normalizeLeaseAgreementDoc($transaction);
        $this->ensureRecoGuide($transaction);
        $this->syncConditionDocs($transaction);

        return $this->payload($transaction);
    }

    /**
     * Drop the form-number prefix from document titles so they read e.g.
     * "Agreement of Purchase and Sale" instead of "100 (Agreement of Purchase and
     * Sale)". Only matches the "<number> (Title)" pattern, so other docs are untouched.
     */
    private function stripFormNumberPrefixes(Transaction $transaction): void
    {
        foreach ($transaction->documents()->whereNull('condition_id')->get() as $doc) {
            if (preg_match('/^\d+\s*\((.+)\)\s*$/', (string) $doc->title, $m)) {
                $doc->update(['title' => trim($m[1])]);
            }
        }
    }

    /** Every transaction's checklist includes the RECO Guide. */
    private function ensureRecoGuide(Transaction $transaction): void
    {
        $exists = $transaction->documents()->whereNull('condition_id')
            ->where('title', 'like', '%RECO Guide%')->exists();
        if (! $exists) {
            $pos = (int) ($transaction->documents()->max('position') ?? 0);
            $transaction->documents()->create(['title' => 'RECO Guide', 'mandatory' => false, 'position' => $pos + 1]);
        }
    }

    /**
     * For lease transactions (e.g. Residential Lease, Commercial Property Lease) the
     * agreement document must read "Agreement to Lease" — never "Agreement of
     * Purchase and Sale". Handles records whose type was switched from a buying type
     * after the checklist was seeded.
     */
    private function normalizeLeaseAgreementDoc(Transaction $transaction): void
    {
        if (! str_contains(strtolower($transaction->type), 'lease')) {
            return;
        }
        foreach ($transaction->documents()->whereNull('condition_id')->get() as $doc) {
            if (stripos($doc->title, 'agreement of purchase') !== false) {
                $doc->update(['title' => 'Agreement to Lease']);
            }
        }
    }

    /**
     * Status-driven documents for deal-side transactions:
     *  - Void: ensure the agreement doc exists (Agreement of Purchase and Sale,
     *    or Agreement to Lease for lease types) — mandatory.
     *  - Mutual Release: the above + a Mutual Release doc (mandatory) + a Deposit
     *    Receipt doc. Works even for Commercial / Business types that ship no
     *    default checklist.
     */
    private function ensureStatusDocs(Transaction $transaction): void
    {
        if (Transaction::isListingStatusFamily($transaction->type)) {
            return; // deal-side statuses only
        }

        $statuses = $transaction->statusList();
        $isMutualRelease = in_array('Mutual Release', $statuses, true);
        $isVoid = in_array('Void', $statuses, true);
        if (! $isMutualRelease && ! $isVoid) {
            return;
        }

        $isLease = str_contains(strtolower($transaction->type), 'lease');
        $docs = $transaction->documents()->whereNull('condition_id')->get();
        $find = fn (string $needle) => $docs->first(fn (Document $d) => str_contains(strtolower($d->title), $needle));
        $pos = (int) ($transaction->documents()->max('position') ?? 0);
        $ensure = function (string $needle, string $title) use ($transaction, $find, &$pos) {
            if (! $find($needle)) {
                $transaction->documents()->create(['title' => $title, 'mandatory' => false, 'position' => ++$pos]);
            }
        };

        // Agreement of Purchase and Sale / Agreement to Lease.
        $isLease
            ? $ensure('agreement to lease', 'Agreement to Lease')
            : $ensure('agreement of purchase', 'Agreement of Purchase and Sale');

        if ($isMutualRelease) {
            $ensure('mutual release', 'Mutual Release');
            $ensure('deposit receipt', 'Deposit Receipt');
        }
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
        $this->guardAgent($request, $transaction);
        $data = $request->validate([
            'documents' => ['present', 'array'],
            'documents.*.id' => ['nullable', 'integer'],
            'documents.*.title' => ['required', 'string', 'max:255'],
            'documents.*.mandatory' => ['nullable', 'boolean'],
            'documents.*.status' => ['nullable', 'in:Pending,Received'],
            'documents.*.validation' => ['nullable', 'in:Pending,Valid,Invalid'],
            'documents.*.remarks' => ['nullable', 'string'],
            'documents.*.reminder' => ['nullable', 'boolean'],
            'documents.*.agent_accepted' => ['nullable', 'in:Accepted,Not Accepted'],
            'reco_audit_ready' => ['nullable', 'in:Yes,No'],
            'reco_audit_remarks' => ['nullable', 'string'],
        ]);

        // Agents may only ADD documents — never change Status/Validation or remove
        // existing rows. Existing documents are left untouched.
        if ($request->user() && $request->user()->role === 'agent') {
            $pos = (int) ($transaction->documents()->max('position') ?? 0);
            foreach (array_values($data['documents']) as $row) {
                if (! empty($row['id'])) {
                    // Agents may record their acceptance answer on an existing doc.
                    // "Not Accepted" also clears the reminder for that document.
                    if (array_key_exists('agent_accepted', $row)) {
                        $doc = $transaction->documents()->find($row['id']);
                        if ($doc && ! $doc->is_condition) {
                            $accepted = $row['agent_accepted'] ?: null;
                            $upd = ['agent_accepted' => $accepted];
                            if ($accepted === 'Not Accepted') {
                                $upd['reminder'] = false;
                            }
                            if ((string) $doc->agent_accepted !== (string) $accepted) {
                                $this->audit->record($transaction, [
                                    'section' => self::SECTION, 'field' => $doc->title.' — Acceptance',
                                    'action' => 'Updated', 'old' => (string) $doc->agent_accepted, 'new' => (string) $accepted,
                                ]);
                            }
                            $doc->update($upd);
                        }
                    }
                    continue;
                }
                $created = $transaction->documents()->create([
                    'title' => $row['title'], 'mandatory' => false, 'manual' => true,
                    'status' => 'Pending', 'validation' => 'Pending', 'position' => ++$pos,
                ]);
                $this->audit->record($transaction, [
                    'section' => self::SECTION, 'field' => $created->title, 'action' => 'Document added',
                ]);
            }
            $this->docsValidation->sync($transaction);

            return $this->payload($transaction->fresh());
        }

        $keep = [];
        foreach (array_values($data['documents']) as $i => $row) {
            $accepted = ($row['agent_accepted'] ?? null) ?: null;
            $attrs = [
                'title' => $row['title'],
                'mandatory' => (bool) ($row['mandatory'] ?? false),
                'status' => $row['status'] ?? 'Pending',
                'validation' => $row['validation'] ?? 'Pending',
                'remarks' => $row['remarks'] ?? null,
                // A document the agent hasn't accepted can never carry a reminder.
                'reminder' => $accepted === 'Not Accepted' ? false : (bool) ($row['reminder'] ?? false),
                'agent_accepted' => $accepted,
                'position' => $i,
            ];
            $existing = ! empty($row['id']) ? $transaction->documents()->find($row['id']) : null;
            if ($existing) {
                foreach (['title' => 'Title', 'status' => 'Status', 'validation' => 'Validation'] as $k => $lbl) {
                    $old = (string) ($existing->getAttribute($k) ?? '');
                    $new = (string) ($attrs[$k] ?? '');
                    if ($old !== $new) {
                        $this->audit->record($transaction, [
                            'section' => self::SECTION, 'field' => $existing->title.' — '.$lbl,
                            'action' => 'Updated', 'old' => $old, 'new' => $new,
                        ]);
                    }
                }
                $existing->update($attrs);
                $keep[] = $existing->id;
            } else {
                // A row without an id came from the "+ Add" field → a manual document.
                $created = $transaction->documents()->create($attrs + ['manual' => true]);
                $keep[] = $created->id;
                $this->audit->record($transaction, [
                    'section' => self::SECTION, 'field' => $created->title, 'action' => 'Document added',
                ]);
            }
        }

        // Remove rows deleted client-side (and their files). Condition rows are
        // managed by syncConditionDocs; docs flagged for deletion by an agent are
        // left for admin review (never hard-deleted here).
        $transaction->documents()->whereNull('condition_id')->where('pending_delete', false)->whereNotIn('id', $keep ?: [0])->get()
            ->each(function (Document $d) use ($transaction) {
                $this->audit->record($transaction, [
                    'section' => self::SECTION, 'field' => $d->title, 'action' => 'Document removed',
                ]);
                $this->purgeFiles($d);
                $d->delete();
            });

        // "Ready for RECO Audit" (Yes/No) + remarks. Remarks only apply to "No".
        if (array_key_exists('reco_audit_ready', $data)) {
            $ready = $data['reco_audit_ready'] ?: null;
            $remarks = $ready === 'No' ? ($data['reco_audit_remarks'] ?? null) : null;
            $oldReady = (string) ($transaction->reco_audit_ready ?? '');
            if ($oldReady !== (string) ($ready ?? '')) {
                $this->audit->record($transaction, [
                    'section' => self::SECTION, 'field' => 'Ready for RECO Audit',
                    'action' => 'Updated', 'old' => $oldReady, 'new' => (string) ($ready ?? ''),
                ]);
            }
            $transaction->update(['reco_audit_ready' => $ready, 'reco_audit_remarks' => $remarks]);
        }

        $this->docsValidation->sync($transaction);

        return $this->payload($transaction->fresh());
    }

    /** Upload a file for a document → marks it Received. */
    public function uploadFile(Request $request, Transaction $transaction, Document $document)
    {
        abort_unless($document->transaction_id === $transaction->id, 404);
        $this->guardAgent($request, $transaction);
        $this->guardAccepted($document);
        $request->validate(['file' => ['required', 'file', 'max:20480']]); // 20 MB

        $file = $request->file('file');
        $user = $request->user();

        // Agents never overwrite an existing file — the previous version is kept as
        // its own document; only admins can later delete it.
        if ($user && $user->role === 'agent' && $document->file_path) {
            $pos = (int) ($transaction->documents()->max('position') ?? 0) + 1;
            $transaction->documents()->create([
                'title' => $document->title,
                'mandatory' => false,
                'status' => 'Received',
                'validation' => 'Pending',
                'position' => $pos,
                'file_name' => $file->getClientOriginalName(),
                'file_path' => $file->store("documents/{$transaction->id}", 'local'),
            ]);
            $this->audit->record($transaction, [
                'section' => self::SECTION, 'field' => $document->title,
                'action' => 'Document version added (previous kept)', 'new' => $file->getClientOriginalName(), 'source' => 'Manual',
            ]);
            $this->docsValidation->sync($transaction);

            return $this->payload($transaction->fresh());
        }

        if ($document->file_path) {
            Storage::disk('local')->delete($document->file_path);
        }

        $replaced = (bool) $document->file_path;
        $path = $file->store("documents/{$transaction->id}", 'local');

        $document->update([
            'file_name' => $file->getClientOriginalName(),
            'file_path' => $path,
            'status' => 'Received',
        ]);

        $this->audit->record($transaction, [
            'section' => self::SECTION, 'field' => $document->title,
            'action' => $replaced ? 'Document replaced' : 'Document uploaded',
            'new' => $file->getClientOriginalName(),
        ]);

        $this->docsValidation->sync($transaction);

        return $this->payload($transaction->fresh());
    }

    /** §13 — upload a file into a multi-file or per-client document (files JSON). */
    public function uploadDocFile(Request $request, Transaction $transaction, Document $document)
    {
        abort_unless($document->transaction_id === $transaction->id, 404);
        $this->guardAgent($request, $transaction);
        $this->guardAccepted($document);
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

        $document->update(['files' => $files, 'status' => $this->docStatusFromFiles($transaction, $document, $files)]);

        $this->audit->record($transaction, [
            'section' => self::SECTION,
            'field' => $document->title.($client ? " ({$client})" : ''),
            'action' => 'Document uploaded',
            'new' => $file->getClientOriginalName(),
        ]);

        $this->docsValidation->sync($transaction);

        return $this->payload($transaction->fresh());
    }

    /**
     * Status for a multi/per-client document from its files. Per-client docs
     * (FINTRAC, Client Photo IDs) are only "Received" once EVERY client has a file.
     */
    private function docStatusFromFiles(Transaction $transaction, Document $document, array $files): string
    {
        if ($document->kind() === 'per_client') {
            $clients = $transaction->clients()->pluck('name')->filter()->unique()->values()->all();
            if (! empty($clients)) {
                $uploaded = collect($files)->pluck('client_name')->filter()->unique()->values()->all();

                return empty(array_diff($clients, $uploaded)) ? 'Received' : 'Pending';
            }
        }

        return $files ? 'Received' : 'Pending';
    }

    /** Remove one file (by index) from a multi-file / per-client document. */
    public function deleteDocFile(Transaction $transaction, Document $document, int $index)
    {
        abort_unless($document->transaction_id === $transaction->id, 404);
        $files = $document->files ?? [];
        if (isset($files[$index])) {
            $removed = $files[$index]['file_name'] ?? null;
            if (! empty($files[$index]['file_path'])) {
                Storage::disk('local')->delete($files[$index]['file_path']);
            }
            array_splice($files, $index, 1);
            $document->update(['files' => $files, 'status' => $this->docStatusFromFiles($transaction, $document, $files)]);
            $this->audit->record($transaction, [
                'section' => self::SECTION, 'field' => $document->title,
                'action' => 'Document file removed', 'old' => $removed,
            ]);
        }

        $this->docsValidation->sync($transaction);

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

        $this->audit->record($transaction, [
            'section' => self::SECTION, 'field' => $document->title,
            'action' => 'Validation attachment uploaded', 'new' => $file->getClientOriginalName(),
        ]);

        $this->docsValidation->sync($transaction);

        return $this->payload($transaction->fresh());
    }

    /** Remove the validation attachment. */
    public function deleteValidationFile(Transaction $transaction, Document $document)
    {
        abort_unless($document->transaction_id === $transaction->id, 404);
        $removed = $document->validation_file_name;
        if ($document->validation_file_path) {
            Storage::disk('local')->delete($document->validation_file_path);
        }
        $document->update(['validation_file_name' => null, 'validation_file_path' => null]);

        $this->audit->record($transaction, [
            'section' => self::SECTION, 'field' => $document->title,
            'action' => 'Validation attachment removed', 'old' => $removed,
        ]);

        $this->docsValidation->sync($transaction);

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

    public function destroy(Request $request, Document $document)
    {
        $transaction = $document->transaction;
        $user = $request->user();

        // Only administrators may delete documents.
        abort_if($user && $user->role === 'agent', 403, 'Only an administrator can delete documents.');

        if ($transaction) {
            $this->audit->record($transaction, [
                'section' => self::SECTION, 'field' => $document->title, 'action' => 'Document deleted',
            ]);
        }
        $this->purgeFiles($document);
        $document->delete();

        if ($transaction) {
            $this->docsValidation->sync($transaction);
        }

        return response()->json(['message' => 'Document deleted']);
    }

    /** Admin restores an agent-flagged document back into the checklist. */
    public function restore(Request $request, Document $document)
    {
        abort_unless($request->user()?->isAdminOrAbove(), 403, 'Administrator access required.');
        $document->update(['pending_delete' => false, 'deleted_by' => null]);
        if ($document->transaction) {
            $this->audit->record($document->transaction, [
                'section' => self::SECTION, 'field' => $document->title, 'action' => 'Document restored',
            ]);
            $this->docsValidation->sync($document->transaction);
        }

        return response()->json(['message' => 'Document restored']);
    }

    private function payload(Transaction $transaction): array
    {
        $allDocs = $transaction->documents()->orderBy('position')->get();
        $deletedDocs = $allDocs->where('pending_delete', true)->values();
        $docs = $allDocs->where('pending_delete', false)->values();
        $total = $docs->count();
        $mandatory = $docs->where('mandatory', true)->count();
        $received = $docs->where('status', 'Received')->count();
        $pending = $total - $received;

        $clients = $transaction->clients()->orderBy('position')->pluck('name')->filter()->values();

        return [
            'clients' => $clients,
            'reco_audit_ready' => $transaction->reco_audit_ready,
            'reco_audit_remarks' => $transaction->reco_audit_remarks,
            'documents' => $docs->map(fn (Document $d) => [
                'id' => $d->id,
                'title' => $d->title,
                'mandatory' => (bool) $d->mandatory,
                'is_condition' => (bool) $d->is_condition,
                'manual' => (bool) $d->manual,
                'kind' => $d->kind(),
                'deadline' => $d->is_condition ? optional(optional($d->condition)->deadline)->toDateString() : null,
                'status' => $d->status,
                'validation' => $d->validation,
                'reminder' => (bool) $d->reminder,
                'agent_accepted' => $d->agent_accepted,
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
            // Agent-flagged deletions awaiting admin review.
            'deleted_documents' => $deletedDocs->map(fn (Document $d) => [
                'id' => $d->id,
                'title' => $d->title,
                'deleted_by' => $d->deleted_by,
                'has_file' => (bool) $d->file_path,
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
