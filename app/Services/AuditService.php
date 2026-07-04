<?php

namespace App\Services;

use App\Models\AuditLog;
use App\Models\Transaction;
use Illuminate\Support\Carbon;

/**
 * Comprehensive audit trail. A transaction is captured as a flat snapshot of
 * every section/field (scalar columns, JSON tracking modules, and nested
 * collections); diffing two snapshots yields one audit entry per real change.
 * Controllers that mutate data outside the main update (documents, notice of
 * sale, etc.) call record() directly with an explicit section + action.
 */
class AuditService
{
    /** Scalar columns → [section, label]. Anything not listed is ignored by the diff. */
    private const SCALAR_MAP = [
        // Basic Information
        'type' => ['Basic Information', 'Transaction Type'],
        'agent' => ['Basic Information', 'Assigned Agent'],
        'conditional_offer' => ['Basic Information', 'Conditional Offer'],
        'inter_board_enabled' => ['Basic Information', 'Inter-Board Enabled'],
        // Property Information
        'property' => ['Property Information', 'Property Address'],
        'mls_type' => ['Property Information', 'MLS Type'],
        'mls_num' => ['Property Information', 'MLS Number'],
        'mls_verified' => ['Property Information', 'MLS Verified'],
        // Dates
        'offer_date' => ['Dates', 'Offer Date'],
        'closing_date' => ['Dates', 'Closing Date'],
        'listing_contract_date' => ['Dates', 'Listing Contract Date'],
        'listing_expiry_date' => ['Dates', 'Listing Expiry Date'],
        // Financial / Deposit
        'price' => ['Financial Information', 'Price'],
        'deposit' => ['Deposit Information', 'Deposit'],
        // Commission Information
        'comm_type' => ['Commission Information', 'Commission Type'],
        'comm_value' => ['Commission Information', 'Commission Value'],
        'comm_pct' => ['Commission Information', 'Commission %'],
        'comm_amt' => ['Commission Information', 'Commission Amount'],
        'comm_adjust_enabled' => ['Commission Information', 'Commission Adjustment Enabled'],
        'comm_adjust_before' => ['Commission Information', 'Commission Adjustment (Before HST)'],
        'comm_adjust_after' => ['Commission Information', 'Commission Adjustment (After HST)'],
        'listing_comm_pct' => ['Commission Information', 'Listing Commission %'],
        'coop_comm_pct' => ['Commission Information', 'Co-op Commission %'],
        'listing_comm_flat' => ['Commission Information', 'Listing Commission (Flat)'],
        'coop_comm_flat' => ['Commission Information', 'Co-op Commission (Flat)'],
        'trust_payable' => ['Commission Information', 'Trust Payable'],
        'listing_adj_enabled' => ['Commission Information', 'Listing Adjustment Enabled'],
        'listing_adj_before' => ['Commission Information', 'Listing Adjustment (Before HST)'],
        'listing_adj_after' => ['Commission Information', 'Listing Adjustment (After HST)'],
        'coop_adj_enabled' => ['Commission Information', 'Co-op Adjustment Enabled'],
        'coop_adj_before' => ['Commission Information', 'Co-op Adjustment (Before HST)'],
        'coop_adj_after' => ['Commission Information', 'Co-op Adjustment (After HST)'],
        'comm_status' => ['Commission Information', 'Commission Status'],
        'comm_paid_status' => ['Commission Information', 'Commission Paid Status'],
        'commission_agent' => ['Commission Information', 'Commission Agent'],
        'precon_listing_type' => ['Commission Information', 'Preconstruction Listing Type'],
        'precon_term_count' => ['Commission Information', 'Preconstruction Term Count'],
        'precon_net_of_hst' => ['Commission Information', 'Preconstruction Net of HST'],
        'precon_comm_pct' => ['Commission Information', 'Preconstruction Commission %'],
        'precon_comm_amt_manual' => ['Commission Information', 'Preconstruction Commission Amount'],
        'precon_details_of_terms' => ['Commission Information', 'Preconstruction Details of Terms'],
        // Legal & Documents
        'lawyer_name' => ['Legal & Documents', 'Lawyer Name'],
        'lawyer_email' => ['Legal & Documents', 'Lawyer Email'],
        'lawyer_phone' => ['Legal & Documents', 'Lawyer Phone'],
        'lawyer_address' => ['Legal & Documents', 'Lawyer Address'],
        'valid_status' => ['Legal & Documents', 'Validation Status'],
        // Builder Information
        'builder_name' => ['Builder Information', 'Builder Name'],
        'builder_vendor' => ['Builder Information', 'Builder Vendor'],
        'builder_project' => ['Builder Information', 'Builder Project'],
        'builder_address' => ['Builder Information', 'Builder Address'],
        'builder_office_email' => ['Builder Information', 'Builder Office Email'],
        'builder_invoice_email' => ['Builder Information', 'Builder Invoice Email'],
        'builder_phone' => ['Builder Information', 'Builder Phone'],
    ];

    /** JSON tracking columns → [section, label-prefix]. Leaves are flattened. */
    private const JSON_MAP = [
        'admin_activities' => ['Quick Actions', 'Admin Activities'],
        'activity_tracker' => ['Quick Actions', 'Activity Tracker'],
        'adjustments' => ['Adjustments', 'Adjustments'],
        'commercial_lease' => ['Financial Information', 'Commercial Lease'],
    ];

    /** Reverse of SCALAR_MAP — the transaction column for an audit field label. */
    public function columnForLabel(?string $label): ?string
    {
        foreach (self::SCALAR_MAP as $col => [, $lbl]) {
            if ($lbl === $label) {
                return $col;
            }
        }

        return null;
    }

    /** Write a single audit entry. */
    public function record(Transaction $t, array $a): void
    {
        $t->auditLogs()->create([
            'who' => request()?->user()?->name ?? 'System',
            'user_id' => request()?->user()?->id,
            'section' => $a['section'] ?? null,
            'field' => $a['field'] ?? null,
            'old_value' => $this->clip($a['old'] ?? null),
            'new_value' => $this->clip($a['new'] ?? null),
            'action' => $a['action'] ?? 'Updated',
            'source' => $a['source'] ?? 'Manual',
            'details' => $a['details'] ?? null,
        ]);
    }

    /**
     * Write a module-level audit entry (not tied to a transaction) for the global
     * Audit Trail. `category` is the sidebar module (Users, Settings, Invoice …).
     */
    public function logModule(string $category, array $a): void
    {
        AuditLog::create([
            'category' => $category,
            'transaction_id' => null,
            'who' => request()?->user()?->name ?? 'System',
            'user_id' => request()?->user()?->id,
            'section' => $a['section'] ?? null,
            'field' => $a['field'] ?? null,
            'old_value' => $this->clip($a['old'] ?? null),
            'new_value' => $this->clip($a['new'] ?? null),
            'action' => $a['action'] ?? 'Updated',
            'source' => $a['source'] ?? 'Manual',
            'details' => $a['details'] ?? null,
        ]);
    }

    /** Diff two snapshots and record one entry per changed field. */
    public function recordChanges(Transaction $t, array $before, array $after, string $source = 'Manual'): void
    {
        foreach ($this->diff($before, $after) as $change) {
            $this->record($t, $change + ['source' => $source]);
        }
    }

    /**
     * Flat snapshot of the whole transaction keyed by "section\x1Ffield" so it can
     * be diffed. Re-queries with all relations so it reflects the persisted state.
     */
    public function snapshot(Transaction $transaction): array
    {
        $t = Transaction::with([
            'clients', 'conditions', 'teamMembers', 'brokerage.agents',
            'statuses', 'interBoardListings', 'preconTerms',
        ])->find($transaction->id);

        if (! $t) {
            return [];
        }

        $out = [];
        $add = function (string $section, string $field, $value) use (&$out) {
            $out[$section."\x1F".$field] = ['section' => $section, 'field' => $field, 'value' => $this->stringify($value)];
        };

        foreach (self::SCALAR_MAP as $col => [$section, $label]) {
            $add($section, $label, $t->getAttribute($col));
        }

        foreach (self::JSON_MAP as $col => [$section, $prefix]) {
            $flat = [];
            $this->flatten($prefix, $t->getAttribute($col), $flat);
            foreach ($flat as $field => $value) {
                $add($section, $field, $value);
            }
        }

        // Client Information
        foreach ($t->clients as $i => $c) {
            $n = $i + 1;
            $add('Client Information', "Client #{$n} Name", $c->name);
            $add('Client Information', "Client #{$n} Email", $c->email);
            $add('Client Information', "Client #{$n} Phone", $c->phone);
        }

        // Conditions
        foreach ($t->conditions as $i => $c) {
            $n = $i + 1;
            $name = $c->custom_name ?: $c->type;
            $add('Conditions', "Condition #{$n} Name", $name);
            $add('Conditions', "Condition #{$n} Deadline", optional($c->deadline)->toDateString());
            $add('Conditions', "Condition #{$n} Status", $c->status);
        }

        // Commission Information — team members
        foreach ($t->teamMembers as $i => $m) {
            $n = $i + 1;
            $add('Commission Information', "Team Member #{$n} Name", $m->name);
            $add('Commission Information', "Team Member #{$n} Split %", $m->split);
            $add('Commission Information', "Team Member #{$n} Agent %", $m->agent_pct);
            $add('Commission Information', "Team Member #{$n} Brokerage %", $m->brok_pct);
            $add('Commission Information', "Team Member #{$n} Scope", $m->scope);
        }

        // Preconstruction terms
        foreach ($t->preconTerms as $term) {
            $add('Commission Information', "Term {$term->term_no} %", $term->pct);
            $add('Commission Information', "Term {$term->term_no} Closing Date", optional($term->closing_date)->toDateString());
        }

        // Contacts — brokerage
        if ($t->brokerage) {
            $b = $t->brokerage;
            $add('Contacts', 'Brokerage Name', $b->name);
            $add('Contacts', 'Brokerage Address', $b->address);
            $add('Contacts', 'Brokerage Email', $b->email);
            $add('Contacts', 'Brokerage Invoice Email', $b->invoice_email);
            $add('Contacts', 'Brokerage Agent Email', $b->agent_email);
            $add('Contacts', 'Brokerage Phone', $b->phone);
            $add('Contacts', 'Listing Agent Name(s)', $b->agents->pluck('name')->filter()->implode(', '));
        }

        // Inter-Board Listings
        foreach ($t->interBoardListings as $i => $ib) {
            $n = $i + 1;
            $add('Property Information', "Inter-Board #{$n} Name", $ib->name);
            $add('Property Information', "Inter-Board #{$n} Board", $ib->board_id);
            $add('Property Information', "Inter-Board #{$n} Verified", $ib->verified);
        }

        // Status
        $add('Status', 'Status', $t->statuses->pluck('status')->implode(', '));

        return $out;
    }

    /** Produce change descriptors (section, field, action, old, new) from two snapshots. */
    private function diff(array $before, array $after): array
    {
        $changes = [];
        foreach (array_keys($before + $after) as $key) {
            $old = $before[$key]['value'] ?? '';
            $new = $after[$key]['value'] ?? '';
            if ($old === $new) {
                continue;
            }
            $meta = $after[$key] ?? $before[$key];
            $action = ($old === '' || $old === null) ? 'Added'
                : ((($new === '' || $new === null)) ? 'Removed' : 'Updated');
            $changes[] = ['section' => $meta['section'], 'field' => $meta['field'], 'action' => $action, 'old' => $old, 'new' => $new];
        }

        return $changes;
    }

    /** Recursively flatten a JSON value into "Prefix → key → key" leaves. */
    private function flatten(string $prefix, $value, array &$out): void
    {
        if (is_array($value)) {
            if ($value === []) {
                return;
            }
            foreach ($value as $k => $v) {
                $label = is_int($k) ? ($prefix.' #'.($k + 1)) : ($prefix.' › '.$this->humanize((string) $k));
                $this->flatten($label, $v, $out);
            }

            return;
        }
        if ($value === null || $value === '') {
            return;
        }
        $out[$prefix] = $value;
    }

    private function humanize(string $key): string
    {
        return ucwords(str_replace(['_', '-'], ' ', $key));
    }

    private function stringify($value): string
    {
        if ($value === null) {
            return '';
        }
        if (is_bool($value)) {
            return $value ? 'Yes' : 'No';
        }
        if ($value instanceof Carbon) {
            return $value->toDateString();
        }
        if (is_array($value)) {
            return json_encode($value);
        }

        return (string) $value;
    }

    private function clip($value): ?string
    {
        if ($value === null) {
            return null;
        }
        $s = (string) $value;

        return mb_strlen($s) > 2000 ? mb_substr($s, 0, 2000).'…' : $s;
    }
}
