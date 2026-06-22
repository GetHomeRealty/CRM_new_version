<?php

namespace App\Http\Resources;

use App\Services\CommissionService;
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
            'comm_status' => $this->comm_status,
            'comm_paid_status' => $this->comm_paid_status,
            'valid_status' => $this->valid_status,

            'conditional_offer' => (bool) $this->conditional_offer,
            'inter_board_enabled' => (bool) $this->inter_board_enabled,

            'statuses' => $this->statusList(),
            'commission' => $commission,

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
}
