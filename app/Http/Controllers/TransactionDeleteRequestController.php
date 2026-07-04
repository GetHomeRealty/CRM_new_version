<?php

namespace App\Http\Controllers;

use App\Models\Transaction;
use App\Models\TransactionDeleteRequest;
use App\Services\AuditService;
use Illuminate\Http\Request;

/**
 * Transaction deletion approval workflow:
 *   Agent requests (reason) → Admin forwards to Super Admin (reason) → Super Admin
 *   approves (deletes the transaction) or rejects.
 */
class TransactionDeleteRequestController extends Controller
{
    public function __construct(private AuditService $audit)
    {
    }

    private const SECTION = 'Approvals';

    /** Agent raises a deletion request for a transaction they own. */
    public function store(Request $request, Transaction $transaction)
    {
        $user = $request->user();
        abort_unless($user && $user->role === 'agent', 403, 'Only agents raise deletion requests.');
        abort_unless($transaction->agent === $user->name, 403, 'You can only request deletion of your own transactions.');
        abort_if(
            $transaction->deleteRequests()->whereIn('status', ['pending', 'forwarded'])->exists(),
            422, 'A deletion request is already in progress for this transaction.'
        );

        $data = $request->validate(['reason' => ['required', 'string', 'max:2000']]);

        $req = $transaction->deleteRequests()->create([
            'requested_by' => $user->id, 'requested_by_name' => $user->name,
            'reason' => $data['reason'], 'status' => 'pending',
        ]);
        $this->audit->record($transaction, [
            'section' => self::SECTION, 'field' => 'Deletion Request', 'action' => 'Deletion requested',
            'source' => 'Manual', 'details' => $data['reason'],
        ]);

        return response()->json($this->payload($req), 201);
    }

    /** Admin forwards the request to a Super Admin for final approval. */
    public function forward(Request $request, TransactionDeleteRequest $deleteRequest)
    {
        abort_unless($request->user()?->isAdminOrAbove(), 403, 'Administrator access required.');
        abort_unless($deleteRequest->status === 'pending', 422, 'This request can no longer be forwarded.');
        $data = $request->validate(['reason' => ['nullable', 'string', 'max:2000']]);

        $deleteRequest->update([
            'status' => 'forwarded',
            'forwarded_by' => $request->user()->id,
            'forwarded_by_name' => $request->user()->name,
            'forward_reason' => $data['reason'] ?? null,
        ]);
        $this->audit->record($deleteRequest->transaction, [
            'section' => self::SECTION, 'field' => 'Deletion Request', 'action' => 'Forwarded to Super Admin',
            'source' => 'Manual', 'details' => $data['reason'] ?? null,
        ]);

        return response()->json($this->payload($deleteRequest));
    }

    /** Super Admin approves — the transaction is deleted. */
    public function approve(Request $request, TransactionDeleteRequest $deleteRequest)
    {
        abort_unless($request->user()?->isSuperAdmin(), 403, 'Only a Super Admin can approve deletion.');
        abort_unless(in_array($deleteRequest->status, ['pending', 'forwarded'], true), 422, 'This request is already resolved.');

        $transaction = $deleteRequest->transaction;
        if ($transaction) {
            $transaction->delete(); // cascades the delete request row
        }

        return response()->json(['message' => 'Transaction deleted', 'deleted' => true]);
    }

    /** Admin or Super Admin rejects the request. */
    public function reject(Request $request, TransactionDeleteRequest $deleteRequest)
    {
        abort_unless($request->user()?->isAdminOrAbove(), 403, 'Administrator access required.');
        $deleteRequest->update([
            'status' => 'rejected',
            'reviewed_by' => $request->user()->id,
            'reviewed_by_name' => $request->user()->name,
            'reviewed_at' => now(),
        ]);
        if ($deleteRequest->transaction) {
            $this->audit->record($deleteRequest->transaction, [
                'section' => self::SECTION, 'field' => 'Deletion Request', 'action' => 'Deletion rejected', 'source' => 'Manual',
            ]);
        }

        return response()->json($this->payload($deleteRequest));
    }

    private function payload(TransactionDeleteRequest $r): array
    {
        return [
            'id' => $r->id,
            'transaction_id' => $r->transaction_id,
            'status' => $r->status,
            'reason' => $r->reason,
            'requested_by_name' => $r->requested_by_name,
            'forwarded_by_name' => $r->forwarded_by_name,
            'forward_reason' => $r->forward_reason,
            'reviewed_by_name' => $r->reviewed_by_name,
            'stamp' => $r->created_at?->toDateTimeString(),
        ];
    }
}
