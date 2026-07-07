<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreTransactionRequest;
use App\Http\Requests\UpdateTransactionRequest;
use App\Http\Resources\TransactionResource;
use App\Models\Transaction;
use App\Models\User;
use App\Services\AuditService;
use App\Services\TradeNumberService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class TransactionController extends Controller
{
    public function __construct(private TradeNumberService $tradeNumbers, private AuditService $audit)
    {
    }

    /** Transactions list (newest first). Agents only see their own + team-split deals. */
    public function index(Request $request)
    {
        $query = Transaction::with('statuses', 'deleteRequests')->latest();

        $user = $request->user();
        if ($user && $user->role === 'agent') {
            $name = $user->name;
            // Own deals, or team-split deals — but ONLY when the transaction has an
            // assigned agent. Unassigned transactions are visible to admins only.
            $query->where(function ($q) use ($name) {
                $q->where('agent', $name)
                    ->orWhere(function ($q2) use ($name) {
                        $q2->whereNotNull('agent')->where('agent', '!=', '')
                            ->whereHas('teamMembers', fn ($tm) => $tm->where('name', $name));
                    });
            });
        }

        $transactions = $query->get();
        $transactions->each(fn (Transaction $t) => $this->applyExpiry($t));

        return TransactionResource::collection($transactions);
    }

    /** Agents may only access transactions they own or are split into. */
    private function authorizeAgentAccess(?User $user, Transaction $t): void
    {
        if (! $user || $user->role !== 'agent') {
            return;
        }
        $name = $user->name;
        // Unassigned transactions (no agent) are admin-only, even if team rows exist.
        $allowed = $t->agent === $name
            || (! empty($t->agent) && $t->teamMembers()->where('name', $name)->exists());
        abort_unless($allowed, 403, 'You do not have access to this transaction.');
    }

    /** Is this user the primary (creating) agent of the transaction? */
    private function isPrimaryAgent(?User $user, Transaction $t): bool
    {
        return $user && $user->role === 'agent' && $t->agent === $user->name;
    }

    /**
     * Listing-side auto-status: once the listing expiry date passes, the status
     * becomes Expired automatically (never set manually). Terminal states are left
     * untouched.
     */
    private function applyExpiry(Transaction $t): void
    {
        if (! Transaction::isListingStatusFamily($t->type) || ! $t->listing_expiry_date) {
            return;
        }
        if (! $t->listing_expiry_date->isPast()) {
            return;
        }
        $current = $t->statuses->pluck('status')->all();
        $terminal = ['Closed', 'Sold', 'Leased', 'Void', 'Terminated', 'Mutual Release', 'DFT', 'Expired'];
        if (array_intersect($current, $terminal)) {
            return;
        }
        $t->statuses()->delete();
        $t->statuses()->create(['status' => 'Expired']);
        $t->load('statuses');
    }

    /**
     * Extract distinguishing address features that must NOT be fuzzed over:
     * directional tokens (N/S/E/W and their long/compound forms) and unit numbers
     * (unit/apt/suite/#, or a leading "5-123" style prefix). Returned sorted so two
     * feature sets can be compared directly for equality.
     */
    private function addrFeatures(string $s): array
    {
        $s = mb_strtolower(trim($s));

        $units = [];
        // Explicit unit markers: unit / apt / apartment / suite / ste / #.
        if (preg_match_all('/(?:unit|apt|apartment|suite|ste|#)\s*\.?\s*([a-z0-9]+)/u', $s, $m)) {
            $units = array_merge($units, $m[1]);
        }
        // Leading "5-123 Main" or "5/123 Main" unit-then-street-number form.
        if (preg_match('/^\s*([a-z0-9]+)\s*[-\/]\s*\d/u', $s, $m)) {
            $units[] = $m[1];
        }
        $units = array_values(array_unique($units));
        sort($units);

        $dirMap = [
            'n' => 'n', 's' => 's', 'e' => 'e', 'w' => 'w',
            'ne' => 'ne', 'nw' => 'nw', 'se' => 'se', 'sw' => 'sw',
            'north' => 'n', 'south' => 's', 'east' => 'e', 'west' => 'w',
            'northeast' => 'ne', 'northwest' => 'nw', 'southeast' => 'se', 'southwest' => 'sw',
        ];
        $dirs = [];
        foreach (preg_split('/[^a-z0-9]+/u', $s, -1, PREG_SPLIT_NO_EMPTY) as $tok) {
            if (isset($dirMap[$tok])) {
                $dirs[$dirMap[$tok]] = $dirMap[$tok];
            }
        }
        $dirs = array_values($dirs);
        sort($dirs);

        return ['dirs' => $dirs, 'units' => $units];
    }

    /**
     * Are two property addresses close enough to be considered the same deal?
     * Normalizes (lowercase, strip punctuation, collapse whitespace) then treats
     * them as a match when identical, when one is a prefix/subset of the other
     * (word-based, e.g. "res buy" vs "res buy rd"), or when overall similarity ≥ 85%.
     */
    private function propertiesSimilar(string $a, string $b): bool
    {
        // Directional tokens (N/S/E/W…) and unit numbers are significant: if they
        // differ, the two addresses are DISTINCT properties (e.g. "123 Main St E" vs
        // "123 Main St W", or unit 5 vs unit 6) and must not be flagged as duplicate.
        $fa = $this->addrFeatures($a);
        $fb = $this->addrFeatures($b);
        if ($fa['dirs'] !== $fb['dirs'] || $fa['units'] !== $fb['units']) {
            return false;
        }

        $norm = static function (string $s): string {
            $s = mb_strtolower(trim($s));
            $s = preg_replace('/[^\p{L}\p{N}\s]+/u', ' ', $s); // drop punctuation
            $s = preg_replace('/\s+/u', ' ', $s);              // collapse whitespace

            return trim((string) $s);
        };

        $na = $norm($a);
        $nb = $norm($b);
        if ($na === '' || $nb === '') {
            return false;
        }
        if ($na === $nb) {
            return true;
        }

        // Word-based prefix/subset: one address is the other plus extra trailing words.
        $wa = explode(' ', $na);
        $wb = explode(' ', $nb);
        $short = count($wa) <= count($wb) ? $wa : $wb;
        $long = count($wa) <= count($wb) ? $wb : $wa;
        if (array_slice($long, 0, count($short)) === $short) {
            return true;
        }

        // Overall character similarity.
        similar_text($na, $nb, $percent);

        return $percent >= 85.0;
    }

    /** Create a transaction from the Add modal. */
    public function store(StoreTransactionRequest $request)
    {
        $data = $request->validated();
        $isListing = Transaction::isListingType($data['type']);
        // An agent creating a transaction becomes its primary agent automatically.
        $creatorAgent = ($request->user() && $request->user()->role === 'agent') ? $request->user()->name : null;

        // Duplicate guard (buying/lease): same Type + Price + Offer Date, with a
        // FUZZY property match — an exact address isn't required. If the other three
        // fields match exactly and the address is very similar (e.g. "res buy" vs
        // "res buy rd"), it's treated as a duplicate.
        if (! $isListing && ! empty($data['offer_date'])) {
            $candidates = Transaction::where('type', $data['type'])
                ->where('price', (float) ($data['price'] ?? 0))
                ->whereDate('offer_date', $data['offer_date'])
                ->get();
            foreach ($candidates as $cand) {
                if ($this->propertiesSimilar((string) $data['property'], (string) $cand->property)) {
                    $on = $cand->agent ? " on {$cand->agent}" : ' (unassigned)';
                    abort(422, "Transaction already exists{$on} — Trade #{$cand->trade_no}. Same Type, Price and Offer Date with a matching Property Address.");
                }
            }
        }

        $commType = $isListing ? '%' : ($data['comm_type'] ?? '%');
        $commValue = $isListing ? 0 : (float) ($data['comm_value'] ?? 0);

        // Team option (bottom of the Add modal). Agent 1 (primary) defaults to the
        // creator; any selected members are added to Team Split with no split % yet
        // (percentages are entered later under Financial Information / Team Split).
        $primaryAgent = ! empty($data['primary_agent']) ? $data['primary_agent'] : $creatorAgent;
        $members = array_values(array_filter($data['team_members'] ?? [], fn ($n) => filled($n)));
        $isTeam = ! empty($data['primary_agent']) || ! empty($members);
        $team = [];
        if ($isTeam && $primaryAgent) {
            // Members chosen at creation get 'full' access (same rights as the primary).
            $team[] = ['name' => $primaryAgent, 'is_primary' => true, 'access' => 'full'];
            foreach ($members as $m) {
                if ($m !== $primaryAgent) {
                    $team[] = ['name' => $m, 'is_primary' => false, 'access' => 'full'];
                }
            }
        }
        $agentName = $isTeam ? $primaryAgent : $creatorAgent;

        $transaction = DB::transaction(function () use ($data, $isListing, $agentName, $commType, $commValue, $team) {
            $t = Transaction::create([
                'trade_no' => $this->tradeNumbers->next($data['type']),
                'type' => $data['type'],
                'property' => $data['property'],
                'agent' => $agentName,
                'price' => $isListing ? 0 : ($data['price'] ?? 0),
                'deposit' => $isListing ? 0 : ($data['deposit'] ?? 0),
                'offer_date' => $isListing ? null : ($data['offer_date'] ?? null),
                'closing_date' => $isListing ? null : ($data['closing_date'] ?? null),
                'listing_contract_date' => $isListing ? ($data['listing_contract_date'] ?? null) : null,
                'listing_expiry_date' => $isListing ? ($data['listing_expiry_date'] ?? null) : null,
                'comm_type' => $commType,
                'comm_value' => $commValue,
                // Reflect the entered value into Financial Information: Fixed → Commission
                // Amount; Percentage → Commission %.
                'comm_amt' => (! $isListing && $commType === 'Fixed' && $commValue > 0) ? $commValue : null,
                'comm_pct' => (! $isListing && $commType === '%' && $commValue > 0) ? $commValue : null,
                'comm_status' => 'Pending',
                'valid_status' => 'Pending',
            ]);

            // Status is picked in the Add modal; fall back to the type default if absent.
            $status = $data['status'] ?? Transaction::defaultStatus($data['type']);
            if ($status) {
                $t->statuses()->create(['status' => $status]);
            }
            $this->audit->record($t, [
                'section' => 'Basic Information', 'action' => 'Record created', 'source' => 'Manual',
                'details' => "Trade #{$t->trade_no} ({$t->type})",
            ]);

            // Seed Team Split with the involved agents (split % entered later).
            if (! empty($team)) {
                $this->syncTeam($t, $team);
            }

            return $t;
        });

        // Transaction Desk v2: auto-generate the commission invoice for invoiceable
        // types on creation. Preconstruction is excluded here because its invoices
        // are per-term and terms aren't set yet at creation — it generates via the
        // "Create Term Invoices" action once terms exist. Never let an invoicing
        // failure block the transaction.
        if (\App\Models\CompanySetting::flag('transaction_desk_v2', true)
            && Transaction::isInvoiceableType($transaction->type)
            && $transaction->type !== 'Preconstruction') {
            try {
                app(\App\Services\TransactionInvoiceService::class)->generate($transaction, skipIfExists: true);
            } catch (\Throwable $e) {
                report($e);
            }
        }

        return (new TransactionResource($this->loadDetail($transaction)))
            ->response()
            ->setStatusCode(201);
    }

    /** Full transaction detail. */
    public function show(Request $request, Transaction $transaction)
    {
        $this->authorizeAgentAccess($request->user(), $transaction);
        $this->applyExpiry($transaction->loadMissing('statuses'));

        return new TransactionResource($this->loadDetail($transaction));
    }

    /** Save the full transaction detail (basic info + nested collections). */
    public function update(UpdateTransactionRequest $request, Transaction $transaction)
    {
        $data = $request->validated();

        // Agents may edit if they OWN the transaction (primary) or are a full-access
        // team member (selected at creation). Docs-only split members are view-only.
        $user = $request->user();
        if ($user && $user->role === 'agent') {
            $isOwner = $transaction->agent === $user->name;
            $isFullMember = $transaction->teamMembers()->where('name', $user->name)->where('access', 'full')->exists();
            abort_unless($isOwner || $isFullMember, 403, 'You do not have edit access to this transaction.');
            // Only the owner is pinned as primary; a full member can never reassign it.
            if ($isOwner) {
                $data['agent'] = $user->name;
            } else {
                unset($data['agent']);
            }
            // Agents cannot modify Financial Information, Adjustments or Admin Activities.
            foreach ([
                'comm_type', 'comm_value', 'comm_pct', 'comm_amt',
                'comm_adjust_enabled', 'comm_adjust_before', 'comm_adjust_after',
                'listing_comm_pct', 'coop_comm_pct', 'listing_comm_flat', 'coop_comm_flat', 'trust_payable',
                'listing_adj_enabled', 'listing_adj_before', 'listing_adj_after',
                'coop_adj_enabled', 'coop_adj_before', 'coop_adj_after',
                'comm_status', 'comm_paid_status',
                'precon_net_of_hst', 'precon_comm_pct', 'precon_comm_amt_manual', 'precon_listing_type',
                'adjustments', 'admin_activities',
            ] as $k) {
                unset($data[$k]);
            }
            // In the Agent FAQ Center, an agent may only toggle the batch review-email
            // flag — everything else in the tracker is preserved as-is.
            if (array_key_exists('activity_tracker', $data)) {
                $existing = $transaction->activity_tracker ?? [];
                $existing['batch_review_email'] = (bool) ($data['activity_tracker']['batch_review_email'] ?? false);
                $data['activity_tracker'] = $existing;
            }
        }

        // Closed — fully locked: only a Super Admin may edit (no request workflow).
        $statuses = $transaction->statusList();
        if (in_array('Closed', $statuses, true) && ! $request->user()?->isSuperAdmin()) {
            abort(403, 'This transaction is Closed — only a Super Admin can edit it.');
        }
        // §5.1 — DFT is locked: non-Super-Admins may only save against an approved
        // edit request (which is then consumed).
        if (in_array('DFT', $statuses, true) && ! $request->user()?->isSuperAdmin()) {
            $approved = $transaction->editRequests()->where('status', 'approved')->latest()->first();
            abort_unless($approved, 403, "This transaction is DFT — edits require Super Admin approval. Use \u{201C}Request Edit\u{201D}.");
            $approved->update(['status' => 'applied']);
        }

        $before = $this->audit->snapshot($transaction);

        DB::transaction(function () use ($data, $transaction, $request) {
            $fill = array_intersect_key($data, array_flip([
                'type', 'property', 'agent', 'price', 'deposit',
                'offer_date', 'closing_date', 'listing_contract_date', 'listing_expiry_date',
                'mls_type', 'mls_num', 'mls_verified',
                'comm_type', 'comm_value', 'comm_pct', 'comm_amt',
                'comm_adjust_enabled', 'comm_adjust_before', 'comm_adjust_after',
                'listing_comm_pct', 'coop_comm_pct', 'listing_comm_flat', 'coop_comm_flat', 'trust_payable',
                'listing_adj_enabled', 'listing_adj_before', 'listing_adj_after',
                'coop_adj_enabled', 'coop_adj_before', 'coop_adj_after',
                'precon_listing_type', 'precon_term_count', 'commission_agent',
                'precon_net_of_hst', 'precon_comm_pct', 'precon_comm_amt_manual', 'precon_details_of_terms',
                'lawyer_name', 'lawyer_email', 'lawyer_phone', 'lawyer_address',
                'buyer_lawyer_name', 'buyer_lawyer_email', 'buyer_lawyer_phone', 'buyer_lawyer_address',
                'seller_lawyer_name', 'seller_lawyer_email', 'seller_lawyer_phone', 'seller_lawyer_address',
                'admin_activities', 'activity_tracker', 'adjustments', 'commercial_lease',
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
                // §5.2 — when a Sale/Lease Listing crosses from Conditional into the
                // final Sold/Leased state, the record must reflect fresh: clear the
                // Mark Verified flag so the closing is re-verified.
                $finals = ['Sold', 'Leased'];
                $oldStatuses = $transaction->statusList();
                $newStatuses = array_values(array_filter($data['statuses']));
                $justSold = Transaction::isListingStatusFamily($transaction->type)
                    && array_intersect($newStatuses, $finals)
                    && ! array_intersect($oldStatuses, $finals);

                $this->syncStatuses($transaction, $data['statuses']);

                if ($justSold && $transaction->mls_verified) {
                    $transaction->update(['mls_verified' => false]);
                }

                // Split upgrade: on this transaction newly Closing, bump the primary
                // agent's default split once they've hit their configured deal threshold.
                if (in_array('Closed', $newStatuses, true) && ! in_array('Closed', $oldStatuses, true)) {
                    $this->applySplitUpgrade($transaction->agent);
                }

                // §5.1 — DFT (deal fell through): the workflow status dropdowns default
                // to N/A. Forced server-side so it holds regardless of the saved payload.
                if (in_array('DFT', $newStatuses, true)) {
                    $transaction->update([
                        'comm_status' => 'N/A',
                        'comm_paid_status' => 'N/A',
                        'valid_status' => 'N/A',
                    ]);
                }
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

            $this->syncClientPayment($transaction);
        });

        // Agent edits are tagged 'Agent' so admins can review them via the per-transaction banner.
        $source = ($user && $user->role === 'agent') ? 'Agent' : 'Manual';
        $this->audit->recordChanges($transaction, $before, $this->audit->snapshot($transaction->fresh()), $source);

        return new TransactionResource($this->loadDetail($transaction->fresh()));
    }

    /** Top-bar bell feed: transactions with agent changes awaiting admin review. */
    public function agentChangeNotifications(Request $request)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdminOrAbove()) {
            return response()->json(['count' => 0, 'items' => []]);
        }

        $txns = Transaction::whereHas('auditLogs', fn ($q) => $q->where('source', 'Agent')->where('handled', false))
            ->with(['auditLogs' => fn ($q) => $q->where('source', 'Agent')->where('handled', false)->latest()])
            ->latest()->get();

        $items = [];
        foreach ($txns as $t) {
            // Team-split and lawyer-detail changes are excluded from notifications.
            $changes = $t->auditLogs->filter(fn ($a) => stripos((string) $a->field, 'Team Member') === false
                && stripos((string) $a->field, 'Lawyer') === false);
            if ($changes->isEmpty()) {
                continue;
            }
            $items[] = [
                'id' => $t->id,
                'trade_no' => $t->trade_no,
                'property' => $t->property,
                'agent' => $t->agent,
                'count' => $changes->count(),
                'at' => optional($changes->first()->created_at)->toDateTimeString(),
            ];
        }

        return response()->json(['count' => count($items), 'items' => $items]);
    }

    /** Admin accepts (marks reviewed) all of the agent's pending changes. */
    public function reviewAgentChanges(Request $request, Transaction $transaction)
    {
        abort_unless($request->user()?->isAdminOrAbove(), 403, 'Administrator access required.');
        $transaction->auditLogs()->where('source', 'Agent')->where('handled', false)->update(['handled' => true]);
        $transaction->update(['agent_review_at' => now()]);

        return new TransactionResource($this->loadDetail($transaction->fresh()));
    }

    /** Admin rejects a single agent change — the field is reverted to its old value. */
    public function rejectAgentChange(Request $request, Transaction $transaction)
    {
        abort_unless($request->user()?->isAdminOrAbove(), 403, 'Administrator access required.');
        $data = $request->validate(['audit_id' => ['required', 'integer']]);

        $log = $transaction->auditLogs()->where('source', 'Agent')->where('handled', false)->find($data['audit_id']);
        abort_unless($log, 404, 'Change not found.');

        $reverted = $this->revertAgentChange($transaction, $log);
        abort_unless($reverted, 422, 'This change can’t be auto-reverted — edit the field manually, then Mark reviewed.');

        $log->update(['handled' => true]);
        $this->audit->record($transaction, [
            'section' => $log->section, 'field' => $log->field, 'action' => 'Agent change rejected (reverted)',
            'source' => 'Manual', 'old' => $log->new_value, 'new' => $log->old_value,
        ]);

        return new TransactionResource($this->loadDetail($transaction->fresh()));
    }

    /** Revert an agent audit change back to its old value. Returns false if unsupported. */
    private function revertAgentChange(Transaction $transaction, $log): bool
    {
        $section = $log->section;
        $field = (string) $log->field;
        $old = $log->old_value;
        $action = $log->action;

        // Status set (comma-separated list).
        if ($section === 'Status' && $field === 'Status') {
            $this->syncStatuses($transaction, array_values(array_filter(array_map('trim', explode(',', (string) $old)))));

            return true;
        }

        // Scalar columns.
        if ($column = $this->audit->columnForLabel($field)) {
            $booleans = ['comm_adjust_enabled', 'listing_adj_enabled', 'coop_adj_enabled', 'precon_net_of_hst', 'mls_verified', 'conditional_offer', 'inter_board_enabled'];
            $dates = ['offer_date', 'closing_date', 'listing_contract_date', 'listing_expiry_date'];
            $value = in_array($column, $booleans, true) ? ($old === 'Yes')
                : (in_array($column, $dates, true) ? (($old === null || $old === '') ? null : $old)
                : (($old === '') ? null : $old));
            $transaction->update([$column => $value]);

            return true;
        }

        // Brokerage contacts.
        if ($section === 'Contacts') {
            $bmap = ['Brokerage Name' => 'name', 'Brokerage Address' => 'address', 'Brokerage Email' => 'email', 'Brokerage Invoice Email' => 'invoice_email', 'Brokerage Agent Email' => 'agent_email', 'Brokerage Phone' => 'phone'];
            if (isset($bmap[$field])) {
                $b = $transaction->brokerage()->firstOrCreate(['transaction_id' => $transaction->id]);
                $b->update([$bmap[$field] => $old === '' ? null : $old]);

                return true;
            }
            if ($field === 'Listing Agent Name(s)') {
                $b = $transaction->brokerage()->firstOrCreate(['transaction_id' => $transaction->id]);
                $b->agents()->delete();
                foreach (array_values(array_filter(array_map('trim', explode(',', (string) $old)))) as $i => $n) {
                    $b->agents()->create(['name' => $n, 'position' => $i]);
                }

                return true;
            }
        }

        // Indexed collections (Clients / Conditions / Inter-Board listings).
        $cols = [
            'Client Information' => ['rel' => 'clients', 'sync' => 'syncClients', 'prefix' => 'Client', 'fields' => ['Name' => 'name', 'Email' => 'email', 'Phone' => 'phone']],
            'Conditions' => ['rel' => 'conditions', 'sync' => 'syncConditions', 'prefix' => 'Condition', 'fields' => ['Name' => 'custom_name', 'Deadline' => 'deadline', 'Status' => 'status']],
            'Property Information' => ['rel' => 'interBoardListings', 'sync' => 'syncInterBoard', 'prefix' => 'Inter-Board', 'fields' => ['Name' => 'name', 'Board' => 'board_id', 'Verified' => 'verified']],
        ];
        foreach ($cols as $sec => $cfg) {
            if ($section !== $sec || ! preg_match('/^'.preg_quote($cfg['prefix'], '/').' #(\d+) (.+)$/', $field, $m)) {
                continue;
            }
            if (! isset($cfg['fields'][$m[2]])) {
                return false;
            }
            $i = (int) $m[1] - 1;
            $sub = $cfg['fields'][$m[2]];
            $val = $sub === 'verified' ? ($old === 'Yes') : (($old === '') ? null : $old);

            $rows = $transaction->{$cfg['rel']}()->orderBy('position')->get()
                ->map(fn ($r) => $this->collectionRowToArray($cfg['rel'], $r))->values()->all();

            if ($action === 'Added') {
                if (isset($rows[$i])) {
                    array_splice($rows, $i, 1);
                }
            } elseif ($action === 'Removed') {
                while (count($rows) <= $i) {
                    $rows[] = $this->blankCollectionRow($cfg['rel']);
                }
                $rows[$i][$sub] = $val;
            } elseif (isset($rows[$i])) {
                $rows[$i][$sub] = $val;
            }
            $this->{$cfg['sync']}($transaction, $rows);

            return true;
        }

        return false;
    }

    private function collectionRowToArray(string $rel, $r): array
    {
        return match ($rel) {
            'clients' => ['name' => $r->name, 'email' => $r->email, 'phone' => $r->phone],
            'conditions' => ['type' => $r->type, 'custom_name' => $r->custom_name, 'deadline' => optional($r->deadline)->toDateString(), 'status' => $r->status],
            'interBoardListings' => ['name' => $r->name, 'board_id' => $r->board_id, 'verified' => (bool) $r->verified],
            default => [],
        };
    }

    private function blankCollectionRow(string $rel): array
    {
        return match ($rel) {
            'clients' => ['name' => '', 'email' => null, 'phone' => null],
            'conditions' => ['type' => 'Financing', 'custom_name' => null, 'deadline' => null, 'status' => 'Pending'],
            'interBoardListings' => ['name' => null, 'board_id' => null, 'verified' => false],
            default => [],
        };
    }

    public function destroy(Request $request, Transaction $transaction)
    {
        // Agents cannot delete directly — they raise a deletion request instead.
        abort_if($request->user() && $request->user()->role === 'agent', 403, 'Agents cannot delete transactions. Request deletion instead.');

        $this->audit->record($transaction, [
            'section' => 'Basic Information', 'action' => 'Record removed', 'source' => 'Manual',
            'details' => "Trade #{$transaction->trade_no} ({$transaction->type})",
        ]);
        $transaction->delete();

        return response()->json(['message' => 'Transaction deleted']);
    }

    /** Per-transaction chat thread. Fetching it marks the thread read for the user. */
    public function messages(Transaction $transaction)
    {
        if ($uid = request()->user()?->id) {
            \App\Models\TransactionMessageRead::updateOrCreate(
                ['transaction_id' => $transaction->id, 'user_id' => $uid],
                ['last_read_at' => now()],
            );
        }

        return response()->json($transaction->messages->map(fn ($m) => [
            'id' => $m->id, 'author' => $m->author, 'body' => $m->body,
            'at' => $m->created_at?->toDateTimeString(),
            'mine' => $m->user_id === request()->user()?->id,
        ]));
    }

    public function postMessage(Request $request, Transaction $transaction)
    {
        $data = $request->validate(['body' => ['required', 'string', 'max:5000']]);
        $transaction->messages()->create([
            'user_id' => $request->user()?->id,
            'author' => $request->user()?->name ?? 'User',
            'body' => $data['body'],
        ]);

        return $this->messages($transaction->fresh('messages'));
    }

    private function loadDetail(Transaction $t): Transaction
    {
        return $t->load([
            'statuses', 'clients', 'conditions', 'interBoardListings',
            'brokerage.agents', 'teamMembers.terms', 'preconTerms', 'auditLogs', 'invoices', 'editRequests', 'deleteRequests',
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

    /**
     * Once an agent has CLOSED the configured number of deals as the PRIMARY agent,
     * apply the new commission split from their user profile — one-time. Only
     * primary-agent deals count. Changes the profile default used for FUTURE
     * transactions; existing records keep their stored per-transaction split.
     */
    private function applySplitUpgrade(?string $agentName): void
    {
        if (! $agentName) {
            return;
        }
        $user = User::where('name', $agentName)->first();
        if (! $user) {
            return;
        }
        $profile = $user->profile ?? [];
        if (! empty($profile['split_upgraded'])) {
            return; // already upgraded
        }
        $threshold = (int) ($profile['completed_deals'] ?? 0);
        $newAgent = $profile['upgrade_agent_pct'] ?? null;
        if ($threshold <= 0 || $newAgent === null || $newAgent === '') {
            return; // no upgrade configured
        }

        $closed = Transaction::where('agent', $agentName)
            ->whereHas('statuses', fn ($q) => $q->where('status', 'Closed'))
            ->count();
        if ($closed < $threshold) {
            return;
        }

        $newBrok = $profile['upgrade_brok_pct'] ?? null;
        $profile['agent_comm_pct'] = (float) $newAgent;
        $profile['brok_comm_pct'] = ($newBrok === null || $newBrok === '')
            ? round(100 - (float) $newAgent, 2)
            : (float) $newBrok;
        $profile['split_upgraded'] = true;
        $user->update(['profile' => $profile]);
    }

    private function syncTeam(Transaction $t, array $team): void
    {
        // Preserve each member's access level across saves (Team Split re-sends the
        // whole list without an access flag). New members added here default to
        // 'docs' (upload docs only); founding members keep 'full'; primary is 'full'.
        $prevAccess = $t->teamMembers()->pluck('access', 'name');
        $t->teamMembers()->delete();
        foreach (array_values($team) as $i => $m) {
            $name = $m['name'] ?? '';
            // Agent %/Brokerage % default to the agent's registered split (from their
            // User profile) and are only overridden when explicitly provided (e.g. a
            // manual edit under Financial Information). Team Split never forces them.
            $hasAgentPct = isset($m['agent_pct']) && $m['agent_pct'] !== null && $m['agent_pct'] !== '';
            if ($hasAgentPct) {
                $agentPct = (float) $m['agent_pct'];
                $brokPct = (isset($m['brok_pct']) && $m['brok_pct'] !== null && $m['brok_pct'] !== '')
                    ? (float) $m['brok_pct'] : round(100 - $agentPct, 2);
            } else {
                $split = $this->agentSplitFromProfile($name, $t->type);
                $agentPct = $split['agent'];
                $brokPct = $split['brok'];
            }
            $isPrimary = (bool) ($m['is_primary'] ?? ($i === 0));
            $access = $isPrimary ? 'full' : ($m['access'] ?? ($prevAccess[$name] ?? 'docs'));
            $member = $t->teamMembers()->create([
                'name' => $name,
                'split' => $m['split'] ?? 0,
                'agent_pct' => $agentPct,
                'brok_pct' => $brokPct,
                'is_primary' => $isPrimary,
                'access' => $access,
                'scope' => $m['scope'] ?? 'Entire',
                'position' => $i,
            ]);
            foreach (array_values(array_unique($m['terms'] ?? [])) as $term) {
                $member->terms()->create(['term_no' => $term]);
            }
        }
    }

    /** Agent/brokerage split registered in the agent's User profile (lease vs sale aware). */
    private function agentSplitFromProfile(?string $name, ?string $type): array
    {
        $isLease = (bool) preg_match('/lease/i', (string) $type);
        $agent = $isLease ? 95.0 : 90.0;
        if ($name) {
            $u = \App\Models\User::where('name', $name)->first(['profile']);
            $p = $u?->profile ?? [];
            $v = $p[$isLease ? 'lease_comm_pct' : 'agent_comm_pct'] ?? null;
            if ($v !== null && $v !== '') {
                $agent = (float) $v;
            }
        }

        return ['agent' => $agent, 'brok' => round(100 - $agent, 2)];
    }

    private function syncStatuses(Transaction $t, array $statuses): void
    {
        $statuses = array_values(array_unique(array_filter($statuses)));
        if (empty($statuses)) {
            $default = Transaction::defaultStatus($t->type);
            $statuses = $default !== '' ? [$default] : [];
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

    /**
     * Keep Client Payment status in sync (listing types only):
     *  - Trust "Payable to Client" = 0 → both Admin Activities "Paid to Client?"
     *    and Agent FAQ "Client Payment Paid" become N/A.
     *  - Admin Activities "Paid to Client?" = Yes → Agent FAQ "Client Payment Paid" = Yes.
     */
    private function syncClientPayment(Transaction $t): void
    {
        if (! Transaction::isListingFinancialType($t->type)) {
            return;
        }

        $breakdown = app(\App\Services\CommissionService::class)->breakdown($t->fresh()->load('teamMembers'));
        if (($breakdown['variant'] ?? null) !== 'listing') {
            return;
        }
        $payable = (float) ($breakdown['trust']['payable_to_client'] ?? 0);
        $receivable = (float) ($breakdown['trust']['receivable_from_lawyer'] ?? 0);

        $admin = $t->admin_activities ?? [];
        $tracker = $t->activity_tracker ?? [];
        $dirty = false;
        $hasVoidCheque = ! empty($tracker['void_cheque']['data'] ?? null);

        // Received from Lawyer? — N/A when nothing is receivable; otherwise default to
        // No (staff flips to Yes manually once funds arrive). Never override Yes/No.
        $recv = $admin['recv_lawyer']['enabled'] ?? null;
        if ($receivable <= 0) {
            if ($recv !== 'N/A') {
                $admin['recv_lawyer'] = array_merge($admin['recv_lawyer'] ?? [], ['enabled' => 'N/A']);
                $dirty = true;
            }
        } elseif ($recv === null || $recv === '' || $recv === 'N/A') {
            $admin['recv_lawyer'] = array_merge($admin['recv_lawyer'] ?? [], ['enabled' => 'No']);
            $dirty = true;
        }

        if ($payable <= 0) {
            // Nothing payable → Paid to Client / Client Payment / Void Cheque are all N/A.
            if (($admin['paid_client']['enabled'] ?? null) !== 'N/A') {
                $admin['paid_client'] = array_merge($admin['paid_client'] ?? [], ['enabled' => 'N/A']);
                $dirty = true;
            }
            if (($tracker['client_payment_paid'] ?? null) !== 'N/A') {
                $tracker['client_payment_paid'] = 'N/A';
                $dirty = true;
            }
            if (($admin['void_cheque_received'] ?? null) !== 'N/A') {
                $admin['void_cheque_received'] = 'N/A';
                $dirty = true;
            }
        } else {
            // Payable > 0 → Paid to Client? defaults to No until paid (never overrides Yes/No).
            $pc = $admin['paid_client']['enabled'] ?? null;
            if ($pc === null || $pc === '' || $pc === 'N/A') {
                $admin['paid_client'] = array_merge($admin['paid_client'] ?? [], ['enabled' => 'No']);
                $pc = 'No';
                $dirty = true;
            }
            if ($pc === 'Yes' && ($tracker['client_payment_paid'] ?? null) !== 'Yes') {
                $tracker['client_payment_paid'] = 'Yes';
                $dirty = true;
            }
            // Uploading a Client Void Cheque marks it received; deleting it reverts to No.
            $vc = $admin['void_cheque_received'] ?? null;
            if ($hasVoidCheque && $vc !== 'Yes') {
                $admin['void_cheque_received'] = 'Yes';
                $dirty = true;
            } elseif (! $hasVoidCheque && $vc === 'Yes') {
                $admin['void_cheque_received'] = 'No';
                $dirty = true;
            }
        }

        if ($dirty) {
            $t->update(['admin_activities' => $admin, 'activity_tracker' => $tracker]);
        }
    }
}
