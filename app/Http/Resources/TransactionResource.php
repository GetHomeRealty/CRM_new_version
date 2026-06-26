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
                'scope' => $m->scope,
                'terms' => $m->relationLoaded('terms') ? $m->terms->pluck('term_no') : [],
            ])),

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
                'field' => $a->field,
                'old_value' => $a->old_value,
                'new_value' => $a->new_value,
                'action' => $a->action,
                'details' => $a->details,
                'stamp' => $a->created_at?->toDateTimeString(),
            ])),

            'created_at' => $this->created_at?->toDateTimeString(),
        ];
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
