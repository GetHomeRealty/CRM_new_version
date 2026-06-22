<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreTransactionRequest;
use App\Http\Requests\UpdateTransactionRequest;
use App\Http\Resources\TransactionResource;
use App\Models\Transaction;
use App\Services\TradeNumberService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class TransactionController extends Controller
{
    public function __construct(private TradeNumberService $tradeNumbers)
    {
    }

    /** Transactions list (newest first). */
    public function index()
    {
        $transactions = Transaction::with('statuses')->latest()->get();

        return TransactionResource::collection($transactions);
    }

    /** Create a transaction from the Add modal. */
    public function store(StoreTransactionRequest $request)
    {
        $data = $request->validated();
        $isListing = Transaction::isListingType($data['type']);

        $transaction = DB::transaction(function () use ($data, $isListing) {
            $t = Transaction::create([
                'trade_no' => $this->tradeNumbers->next($data['type']),
                'type' => $data['type'],
                'property' => $data['property'],
                'price' => $isListing ? 0 : ($data['price'] ?? 0),
                'deposit' => $isListing ? 0 : ($data['deposit'] ?? 0),
                'offer_date' => $isListing ? null : ($data['offer_date'] ?? null),
                'closing_date' => $isListing ? null : ($data['closing_date'] ?? null),
                'listing_contract_date' => $isListing ? ($data['listing_contract_date'] ?? null) : null,
                'listing_expiry_date' => $isListing ? ($data['listing_expiry_date'] ?? null) : null,
                'comm_type' => $isListing ? '%' : ($data['comm_type'] ?? '%'),
                'comm_value' => $isListing ? 0 : ($data['comm_value'] ?? 0),
                'comm_status' => 'Pending',
                'valid_status' => 'Pending',
            ]);

            $t->statuses()->create(['status' => 'Open']);
            $this->audit($t, null, 'Transaction created', "Trade #{$t->trade_no} ({$t->type})");

            return $t;
        });

        return (new TransactionResource($this->loadDetail($transaction)))
            ->response()
            ->setStatusCode(201);
    }

    /** Full transaction detail. */
    public function show(Transaction $transaction)
    {
        return new TransactionResource($this->loadDetail($transaction));
    }

    /** Save the full transaction detail (basic info + nested collections). */
    public function update(UpdateTransactionRequest $request, Transaction $transaction)
    {
        $data = $request->validated();

        DB::transaction(function () use ($data, $transaction, $request) {
            $this->auditBasicChanges($transaction, $data);

            $fill = array_intersect_key($data, array_flip([
                'type', 'property', 'agent', 'price', 'deposit',
                'offer_date', 'closing_date', 'listing_contract_date', 'listing_expiry_date',
                'mls_type', 'mls_num', 'mls_verified',
                'comm_type', 'comm_value', 'comm_pct', 'comm_amt',
                'comm_adjust_enabled', 'comm_adjust_before', 'comm_adjust_after',
                'listing_comm_pct', 'coop_comm_pct',
                'listing_adj_enabled', 'listing_adj_before', 'listing_adj_after',
                'coop_adj_enabled', 'coop_adj_before', 'coop_adj_after',
                'precon_listing_type', 'precon_term_count', 'commission_agent',
                'precon_net_of_hst', 'precon_comm_pct', 'precon_comm_amt_manual', 'precon_details_of_terms',
                'comm_status', 'comm_paid_status', 'valid_status',
                'conditional_offer', 'inter_board_enabled',
            ]));

            // Builder Information (nested object → flat builder_* columns).
            if (array_key_exists('builder', $data) && is_array($data['builder'])) {
                foreach (['name', 'vendor', 'project', 'address', 'office_email', 'invoice_email', 'phone'] as $key) {
                    $fill['builder_'.$key] = $data['builder'][$key] ?? null;
                }
            }

            $transaction->fill($fill)->save();

            if (array_key_exists('team', $data)) {
                $this->syncTeam($transaction, $data['team']);
            }
            if (array_key_exists('precon_terms', $data)) {
                $this->syncPreconTerms($transaction, $data['precon_terms']);
            }

            if (array_key_exists('statuses', $data)) {
                $this->syncStatuses($transaction, $data['statuses']);
            }
            if (array_key_exists('clients', $data)) {
                $this->syncClients($transaction, $data['clients']);
            }
            if (array_key_exists('conditions', $data)) {
                $this->syncConditions($transaction, $data['conditions']);
            }
            if (array_key_exists('inter_board_listings', $data)) {
                $this->syncInterBoard($transaction, $data['inter_board_listings']);
            }
            if (array_key_exists('brokerage', $data)) {
                $this->syncBrokerage($transaction, $data['brokerage']);
            }
        });

        return new TransactionResource($this->loadDetail($transaction->fresh()));
    }

    public function destroy(Transaction $transaction)
    {
        $transaction->delete();

        return response()->json(['message' => 'Transaction deleted']);
    }

    private function loadDetail(Transaction $t): Transaction
    {
        return $t->load([
            'statuses', 'clients', 'conditions', 'interBoardListings',
            'brokerage.agents', 'teamMembers.terms', 'preconTerms', 'auditLogs',
        ]);
    }

    private function syncPreconTerms(Transaction $t, array $terms): void
    {
        $t->preconTerms()->delete();
        foreach ($terms as $term) {
            if (! isset($term['term_no'])) {
                continue;
            }
            $t->preconTerms()->create([
                'term_no' => $term['term_no'],
                'pct' => $term['pct'] ?? null,
                'closing_date' => $term['closing_date'] ?? null,
            ]);
        }
    }

    private function syncTeam(Transaction $t, array $team): void
    {
        $t->teamMembers()->delete();
        foreach (array_values($team) as $i => $m) {
            $member = $t->teamMembers()->create([
                'name' => $m['name'] ?? '',
                'split' => $m['split'] ?? 0,
                'agent_pct' => $m['agent_pct'] ?? 90,
                'brok_pct' => $m['brok_pct'] ?? 10,
                'is_primary' => (bool) ($m['is_primary'] ?? ($i === 0)),
                'scope' => $m['scope'] ?? 'Entire',
                'position' => $i,
            ]);
            foreach (array_values(array_unique($m['terms'] ?? [])) as $term) {
                $member->terms()->create(['term_no' => $term]);
            }
        }
    }

    private function syncStatuses(Transaction $t, array $statuses): void
    {
        $statuses = array_values(array_unique(array_filter($statuses)));
        if (empty($statuses)) {
            $statuses = ['Open'];
        }
        $t->statuses()->delete();
        foreach ($statuses as $status) {
            $t->statuses()->create(['status' => $status]);
        }
    }

    private function syncClients(Transaction $t, array $clients): void
    {
        $t->clients()->delete();
        foreach (array_values($clients) as $i => $c) {
            $t->clients()->create([
                'name' => $c['name'] ?? '',
                'email' => $c['email'] ?? null,
                'phone' => $c['phone'] ?? null,
                'position' => $i,
            ]);
        }
    }

    private function syncConditions(Transaction $t, array $conditions): void
    {
        $t->conditions()->delete();
        foreach (array_values($conditions) as $i => $c) {
            $t->conditions()->create([
                'type' => $c['type'] ?? 'Financing',
                'custom_name' => $c['custom_name'] ?? null,
                'deadline' => $c['deadline'] ?? null,
                'status' => $c['status'] ?? 'Pending',
                'position' => $i,
            ]);
        }
    }

    private function syncInterBoard(Transaction $t, array $items): void
    {
        $t->interBoardListings()->delete();
        foreach (array_values($items) as $i => $item) {
            $t->interBoardListings()->create([
                'name' => $item['name'] ?? null,
                'board_id' => $item['board_id'] ?? null,
                'verified' => (bool) ($item['verified'] ?? false),
                'position' => $i,
            ]);
        }
    }

    private function syncBrokerage(Transaction $t, ?array $data): void
    {
        if ($data === null) {
            return;
        }

        $brokerage = $t->brokerage()->updateOrCreate(
            ['transaction_id' => $t->id],
            [
                'name' => $data['name'] ?? null,
                'address' => $data['address'] ?? null,
                'email' => $data['email'] ?? null,
                'invoice_email' => $data['invoice_email'] ?? null,
                'agent_email' => $data['agent_email'] ?? null,
                'phone' => $data['phone'] ?? null,
            ]
        );

        $brokerage->agents()->delete();
        foreach (array_values(array_filter($data['agents'] ?? [])) as $i => $name) {
            $brokerage->agents()->create(['name' => $name, 'position' => $i]);
        }
    }

    /** Diff a handful of key basic-info fields and record them in the audit log. */
    private function auditBasicChanges(Transaction $t, array $data): void
    {
        $watch = [
            'property' => 'Basic Info — Property',
            'type' => 'Basic Info — Type',
            'agent' => 'Basic Info — Assigned Agent',
            'price' => 'Basic Info — Price',
            'deposit' => 'Basic Info — Deposit',
            'offer_date' => 'Basic Info — Offer Date',
            'closing_date' => 'Basic Info — Closing Date',
            'mls_num' => 'Basic Info — MLS #',
            'comm_pct' => 'Financial — Commission %',
            'comm_amt' => 'Financial — Commission Amount',
        ];

        foreach ($watch as $field => $label) {
            if (! array_key_exists($field, $data)) {
                continue;
            }
            $old = (string) ($t->getAttribute($field) ?? '');
            $new = (string) ($data[$field] ?? '');
            if ($old !== $new) {
                $this->audit($t, $label, 'Transaction saved', null, $old, $new);
            }
        }
    }

    private function audit(Transaction $t, ?string $field, string $action, ?string $details = null, ?string $old = null, ?string $new = null): void
    {
        $t->auditLogs()->create([
            'who' => request()->user()?->name ?? 'System',
            'user_id' => request()->user()?->id,
            'field' => $field,
            'old_value' => $old,
            'new_value' => $new,
            'action' => $action,
            'details' => $details,
        ]);
    }
}
