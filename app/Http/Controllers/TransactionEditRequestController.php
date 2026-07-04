<?php

namespace App\Http\Controllers;

use App\Models\Transaction;
use App\Models\TransactionEditRequest;
use App\Services\AuditService;
use Illuminate\Http\Request;

/**
 * §5.1 — edit-approval workflow for DFT / Closed transactions. An Admin (manager)
 * raises a request; a Super Admin approves it, which permits the next edit.
 */
class TransactionEditRequestController extends Controller
{
    public function __construct(private AuditService $audit)
    {
    }

    /** Admin raises an edit request (only meaningful while the transaction is locked). */
    public function store(Request $request, Transaction $transaction)
    {
        $user = $request->user();
        abort_unless($user && $user->isAdminOrAbove(), 403, 'Only Admins can request edits.');
        // Closed transactions are Super-Admin-only with no request workflow.
        abort_if(in_array('Closed', $transaction->statusList(), true), 403, 'Closed transactions can only be edited by a Super Admin.');
        $data = $request->validate(['reason' => ['nullable', 'string', 'max:2000']]);

        $status = implode(', ', array_intersect($transaction->statusList(), ['DFT', 'Closed'])) ?: ($transaction->statusList()[0] ?? '');
        $req = $transaction->editRequests()->create([
            'status_at_request' => $status,
            'requested_by' => $user->id,
            'requested_by_name' => $user->name,
            'reason' => $data['reason'] ?? null,
            'status' => 'pending',
        ]);

        $this->audit->record($transaction, [
            'section' => 'Approvals', 'field' => 'Edit Request', 'action' => 'Edit requested',
            'source' => 'Manual', 'new' => $req->status_at_request, 'details' => $data['reason'] ?? null,
        ]);

        return response()->json($this->payload($req), 201);
    }

    /** Super Admin approves a pending request — the next save by the Admin is allowed. */
    public function approve(Request $request, TransactionEditRequest $editRequest)
    {
        abort_unless($request->user()?->isSuperAdmin(), 403, 'Only a Super Admin can approve.');
        $editRequest->update([
            'status' => 'approved',
            'reviewed_by' => $request->user()->id,
            'reviewed_by_name' => $request->user()->name,
            'reviewed_at' => now(),
        ]);
        $this->audit->record($editRequest->transaction, [
            'section' => 'Approvals', 'field' => 'Edit Request', 'action' => 'Edit approved', 'source' => 'Manual',
        ]);

        return response()->json($this->payload($editRequest));
    }

    /** Super Admin rejects a pending request. */
    public function reject(Request $request, TransactionEditRequest $editRequest)
    {
        abort_unless($request->user()?->isSuperAdmin(), 403, 'Only a Super Admin can reject.');
        $editRequest->update([
            'status' => 'rejected',
            'reviewed_by' => $request->user()->id,
            'reviewed_by_name' => $request->user()->name,
            'reviewed_at' => now(),
        ]);
        $this->audit->record($editRequest->transaction, [
            'section' => 'Approvals', 'field' => 'Edit Request', 'action' => 'Edit rejected', 'source' => 'Manual',
        ]);

        return response()->json($this->payload($editRequest));
    }

    private function payload(TransactionEditRequest $r): array
    {
        return [
            'id' => $r->id,
            'status' => $r->status,
            'status_at_request' => $r->status_at_request,
            'requested_by_name' => $r->requested_by_name,
            'reason' => $r->reason,
            'reviewed_by_name' => $r->reviewed_by_name,
            'reviewed_at' => optional($r->reviewed_at)->toDateTimeString(),
            'stamp' => $r->created_at?->toDateTimeString(),
        ];
    }
}
