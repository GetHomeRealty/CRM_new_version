<?php

namespace App\Http\Resources;

use App\Models\Transaction;
use App\Services\CommissionService;
use App\Services\InvoiceStatusService;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class TransactionResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        $commission = app(CommissionService::class)->summarize($this->resource);

        return [
            'id' => $this->id,
            'trade_no' => $this->trade_no,
            'type' => $this->type,
            'property' => $this->property,
            'agent' => $this->agent,
            'price' => (float) $this->price,
            'deposit' => (float) $this->deposit,
            'offer_date' => optional($this->offer_date)->toDateString(),
            'closing_date' => optional($this->closing_date)->toDateString(),
            'listing_contract_date' => optional($this->listing_contract_date)->toDateString(),
            'listing_expiry_date' => optional($this->listing_expiry_date)->toDateString(),

            'mls_type' => $this->mls_type,
            'mls_num' => $this->mls_num,
            'mls_verified' => (bool) $this->mls_verified,

            'comm_type' => $this->comm_type,
            'comm_value' => (float) $this->comm_value,
            'comm_pct' => $this->comm_pct !== null ? (float) $this->comm_pct : null,
            'comm_amt' => $this->comm_amt !== null ? (float) $this->comm_amt : null,
            'comm_adjust_enabled' => (bool) $this->comm_adjust_enabled,
            'comm_adjust_before' => (float) $this->comm_adjust_before,
            'comm_adjust_after' => (float) $this->comm_adjust_after,
            'listing_comm_pct' => $this->listing_comm_pct !== null ? (float) $this->listing_comm_pct : null,
            'coop_comm_pct' => $this->coop_comm_pct !== null ? (float) $this->coop_comm_pct : null,
            'listing_comm_flat' => $this->listing_comm_flat !== null ? (float) $this->listing_comm_flat : null,
            'coop_comm_flat' => $this->coop_comm_flat !== null ? (float) $this->coop_comm_flat : null,
            'trust_payable' => $this->trust_payable !== null ? (float) $this->trust_payable : null,
            'listing_adj_enabled' => (bool) $this->listing_adj_enabled,
            'listing_adj_before' => (float) $this->listing_adj_before,
            'listing_adj_after' => (float) $this->listing_adj_after,
            'coop_adj_enabled' => (bool) $this->coop_adj_enabled,
            'coop_adj_before' => (float) $this->coop_adj_before,
            'coop_adj_after' => (float) $this->coop_adj_after,
            'comm_status' => $this->comm_status,
            'comm_paid_status' => $this->comm_paid_status,
            'valid_status' => $this->valid_status,

            'conditional_offer' => (bool) $this->conditional_offer,
            'inter_board_enabled' => (bool) $this->inter_board_enabled,

            // Lawyer
            'lawyer_name' => $this->lawyer_name,
            'lawyer_email' => $this->lawyer_email,
            'lawyer_phone' => $this->lawyer_phone,
            'lawyer_address' => $this->lawyer_address,

            // Tracking modules (freeform JSON)
            'admin_activities' => $this->admin_activities,
            'activity_tracker' => $this->activity_tracker,
            'adjustments' => $this->adjustments,
            'commercial_lease' => $this->commercial_lease,
            'notice_of_sale' => $this->notice_of_sale,

            // Preconstruction
            'precon_listing_type' => $this->precon_listing_type,
            'precon_term_count' => $this->precon_term_count !== null ? (int) $this->precon_term_count : null,
            'commission_agent' => $this->commission_agent,
            'precon_net_of_hst' => (bool) $this->precon_net_of_hst,
            'precon_comm_pct' => $this->precon_comm_pct !== null ? (float) $this->precon_comm_pct : null,
            'precon_comm_amt_manual' => $this->precon_comm_amt_manual !== null ? (float) $this->precon_comm_amt_manual : null,
            'precon_details_of_terms' => $this->precon_details_of_terms,
            'builder' => [
                'name' => $this->builder_name,
                'vendor' => $this->builder_vendor,
                'project' => $this->builder_project,
                'address' => $this->builder_address,
                'office_email' => $this->builder_office_email,
                'invoice_email' => $this->builder_invoice_email,
                'phone' => $this->builder_phone,
            ],
            'precon_terms' => $this->whenLoaded('preconTerms', fn () => $this->preconTerms->map(fn ($p) => [
                'term_no' => $p->term_no,
                'pct' => $p->pct !== null ? (float) $p->pct : null,
                'closing_date' => optional($p->closing_date)->toDateString(),
            ])),

            'statuses' => $this->statusList(),
            'commission' => $commission,

            'team' => $this->whenLoaded('teamMembers', fn () => $this->teamMembers->map(fn ($m) => [
                'id' => $m->id,
                'name' => $m->name,
                'split' => (float) $m->split,
                'agent_pct' => (float) $m->agent_pct,
                'brok_pct' => (float) $m->brok_pct,
                'is_primary' => (bool) $m->is_primary,
                'access' => $m->access,
                'scope' => $m->scope,
                'terms' => $m->relationLoaded('terms') ? $m->terms->pluck('term_no') : [],
            ])),

            // Current agent's access to this transaction: 'full' (primary or founding
            // team member) → same edit rights as primary; 'docs' → upload docs only,
            // rest view-only; null → not an agent / not on the team.
            'my_team_access' => $this->myTeamAccess($request),

            // Full backend-computed Financial breakdown (standard variant).
            'financial' => $this->when(
                $this->relationLoaded('teamMembers'),
                fn () => app(CommissionService::class)->breakdown($this->resource)
            ),

            'clients' => $this->whenLoaded('clients', fn () => $this->clients->map(fn ($c) => [
                'id' => $c->id,
                'name' => $c->name,
                'email' => $c->email,
                'phone' => $c->phone,
            ])),

            'conditions' => $this->whenLoaded('conditions', fn () => $this->conditions->map(fn ($c) => [
                'id' => $c->id,
                'type' => $c->type,
                'custom_name' => $c->custom_name,
                'deadline' => optional($c->deadline)->toDateString(),
                'status' => $c->status,
            ])),

            'inter_board_listings' => $this->whenLoaded('interBoardListings', fn () => $this->interBoardListings->map(fn ($i) => [
                'id' => $i->id,
                'name' => $i->name,
                'board_id' => $i->board_id,
                'verified' => (bool) $i->verified,
            ])),

            'brokerage' => $this->whenLoaded('brokerage', function () {
                if (! $this->brokerage) {
                    return null;
                }

                return [
                    'name' => $this->brokerage->name,
                    'address' => $this->brokerage->address,
                    'email' => $this->brokerage->email,
                    'invoice_email' => $this->brokerage->invoice_email,
                    'agent_email' => $this->brokerage->agent_email,
                    'phone' => $this->brokerage->phone,
                    'agents' => $this->brokerage->agents->pluck('name'),
                ];
            }),

            'invoices' => $this->whenLoaded('invoices', fn () => $this->invoices->map(fn ($inv) => [
                'id' => $inv->id,
                'invoice_no' => $inv->invoice_no,
                'status' => $inv->status,
                'total' => (float) $inv->total,
            ])),

            // §12.4 — auto invoice fields for the Admin Activities block (read-only).
            'invoice_admin' => $this->whenLoaded('invoices', fn () => $this->invoiceAdmin()),

            'audit_logs' => $this->whenLoaded('auditLogs', fn () => $this->auditLogs->map(fn ($a) => [
                'id' => $a->id,
                'who' => $a->who,
                'section' => $a->section,
                'field' => $a->field,
                'old_value' => $a->old_value,
                'new_value' => $a->new_value,
                'action' => $a->action,
                'source' => $a->source,
                'details' => $a->details,
                'stamp' => $a->created_at?->toDateTimeString(),
            ])),

            // Agent-made changes awaiting admin review (per-transaction banner).
            'agent_changes' => $this->whenLoaded('auditLogs', function () {
                return $this->auditLogs
                    ->filter(fn ($a) => $a->source === 'Agent' && ! $a->handled
                        && stripos((string) $a->field, 'Team Member') === false
                        && stripos((string) $a->field, 'Lawyer') === false)
                    ->map(fn ($a) => [
                        'id' => $a->id,
                        'who' => $a->who,
                        'section' => $a->section,
                        'field' => $a->field,
                        'action' => $a->action,
                        'old_value' => $a->old_value,
                        'new_value' => $a->new_value,
                        'stamp' => $a->created_at?->toDateTimeString(),
                    ])->values();
            }),

            // Active (pending/forwarded) transaction deletion request, if any.
            'delete_request' => $this->whenLoaded('deleteRequests', function () {
                $r = $this->deleteRequests->firstWhere(fn ($x) => in_array($x->status, ['pending', 'forwarded'], true));

                return $r ? [
                    'id' => $r->id,
                    'status' => $r->status,
                    'reason' => $r->reason,
                    'requested_by_name' => $r->requested_by_name,
                    'forwarded_by_name' => $r->forwarded_by_name,
                    'forward_reason' => $r->forward_reason,
                    'stamp' => $r->created_at?->toDateTimeString(),
                ] : null;
            }),

            // Unread chat messages for the requesting user (badge on the list row).
            'unread_messages' => $this->unreadMessages($request),

            'edit_locked' => $this->isEditLocked(),
            'edit_requests' => $this->whenLoaded('editRequests', fn () => $this->editRequests->map(fn ($r) => [
                'id' => $r->id,
                'status' => $r->status,
                'status_at_request' => $r->status_at_request,
                'requested_by_name' => $r->requested_by_name,
                'reason' => $r->reason,
                'reviewed_by_name' => $r->reviewed_by_name,
                'reviewed_at' => optional($r->reviewed_at)->toDateTimeString(),
                'stamp' => $r->created_at?->toDateTimeString(),
            ])),

            'created_at' => $this->created_at?->toDateTimeString(),
        ];
    }

    /**
     * Count of chat messages the requesting user hasn't seen — messages posted by
     * someone else after the user's last read of this transaction's thread.
     */
    private function unreadMessages(Request $request): int
    {
        $user = $request->user();
        if (! $user) {
            return 0;
        }
        $lastRead = \App\Models\TransactionMessageRead::where('transaction_id', $this->id)
            ->where('user_id', $user->id)
            ->value('last_read_at');

        return $this->messages()
            ->where('user_id', '!=', $user->id)
            ->when($lastRead, fn ($q) => $q->where('created_at', '>', $lastRead))
            ->count();
    }

    /**
     * The requesting agent's access level to this transaction:
     * 'full' for the primary agent or a full-access team member, 'docs' for a
     * docs-only split member, null for admins / non-members.
     */
    private function myTeamAccess(Request $request): ?string
    {
        $user = $request->user();
        if (! $user || $user->role !== 'agent') {
            return null;
        }
        if ($this->agent === $user->name) {
            return 'full';
        }
        $member = $this->relationLoaded('teamMembers')
            ? $this->teamMembers->firstWhere('name', $user->name)
            : $this->teamMembers()->where('name', $user->name)->first();

        return $member?->access;
    }

    /**
     * §12.4 auto fields for Admin Activities. Normal transactions → a single
     * block; Preconstruction → one block per term (keyed by term_no). The sent
     * status is derived (never stored) so it always reflects the live invoice.
     */
    private function invoiceAdmin(): array
    {
        $svc = app(InvoiceStatusService::class);
        $closing = $this->closing_date;

        $block = fn ($inv) => [
            'invoice_number' => $inv?->invoice_no,
            'invoice_sent_status' => $svc->sentStatus($inv, ($inv?->due_date) ?: $closing),
            'commission_received_date' => optional($inv?->commission_received_date)->toDateString(),
            'commission_received_via' => $inv?->commission_received_via,
        ];

        if (Transaction::isPreconType($this->type)) {
            $byTerm = [];
            foreach ($this->invoices as $inv) {
                if ($inv->term_no) {
                    $byTerm[$inv->term_no] = $block($inv);
                }
            }

            return ['by_term' => $byTerm];
        }

        return $block($this->invoices->first());
    }
}
