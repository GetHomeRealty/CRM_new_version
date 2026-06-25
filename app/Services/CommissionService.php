<?php

namespace App\Services;

use App\Models\TeamMember;
use App\Models\Transaction;

/**
 * Backend-authoritative commission math. PHP is the source of truth for all
 * money values; the React client renders what this returns.
 *
 * Stage 1 implements the gross commission/HST/total + paid-vs-pending split
 * used by the transactions list and analytics tiles. The full per-agent /
 * team-split / precon / commercial-lease breakdowns will extend this service
 * in later stages.
 */
class CommissionService
{
    public const HST_RATE = 0.13;

    /**
     * Gross commission for a transaction, mirroring the precedence used in
     * buildAnalyticsDashboardHTML(): explicit amount → percent → legacy
     * type/value pair.
     *
     * @return array{amount:float,hst:float,total:float,paid:bool}
     */
    public function summarize(Transaction $t): array
    {
        $price = (float) $t->price;
        $amount = 0.0;

        if ($t->comm_amt !== null && (float) $t->comm_amt > 0) {
            $amount = (float) $t->comm_amt;
        } elseif ($t->comm_pct !== null && (float) $t->comm_pct > 0) {
            $amount = $price * (float) $t->comm_pct / 100;
        } elseif ($t->comm_type === '%' && (float) $t->comm_value > 0) {
            $amount = $price * (float) $t->comm_value / 100;
        } elseif ($t->comm_type === 'Fixed' && (float) $t->comm_value > 0) {
            $amount = (float) $t->comm_value;
        }

        $amount = round($amount, 2);
        $hst = round($amount * self::HST_RATE, 2);
        $total = round($amount + $hst, 2);

        $paid = $t->comm_paid_status === 'Yes' || $t->comm_status === 'Received';

        return compact('amount', 'hst', 'total', 'paid');
    }

    /** Gross commission amount (before adjustments/HST). */
    private function grossBase(Transaction $t): float
    {
        $price = (float) $t->price;

        if ($t->comm_amt !== null && (float) $t->comm_amt > 0) {
            return round((float) $t->comm_amt, 2);
        }
        if ($t->comm_pct !== null && (float) $t->comm_pct > 0) {
            return round($price * (float) $t->comm_pct / 100, 2);
        }
        if ($t->comm_type === '%' && (float) $t->comm_value > 0) {
            return round($price * (float) $t->comm_value / 100, 2);
        }
        if ($t->comm_type === 'Fixed' && (float) $t->comm_value > 0) {
            return round((float) $t->comm_value, 2);
        }

        return 0.0;
    }

    /**
     * Full Financial breakdown. Dispatches by transaction type to the
     * standard (buying/lease) or listing variant. (Precon: Stage 2B-2.)
     */
    public function breakdown(Transaction $t): array
    {
        if (Transaction::isPreconType($t->type)) {
            return $this->breakdownPrecon($t);
        }
        if (Transaction::isListingFinancialType($t->type)) {
            return $this->breakdownListing($t);
        }

        return $this->breakdownStandard($t);
    }

    /**
     * Preconstruction variant — a master commission split across N terms, with
     * an optional NET-of-HST mode and per-term, term-scoped agent breakdowns.
     * Ports computePreconMasterTotals() + recalcFinPrecon() + recalcAgentCommPrecon().
     * Min brokerage floor is $200 / $226.
     */
    private function breakdownPrecon(Transaction $t): array
    {
        $price = (float) $t->price;
        $netHst = (bool) $t->precon_net_of_hst;

        // Master totals
        $manual = $t->precon_comm_amt_manual;
        if ($manual !== null && $manual !== '') {
            $amount = round((float) $manual, 2);
        } else {
            $pct = (float) $t->precon_comm_pct;
            $amount = round($price * $pct / 100, 2);
        }

        if ($netHst) {
            $commission = round($amount / 1.13, 2);
            $hst = round($amount - $commission, 2);
            $total = $amount;
        } else {
            $commission = $amount;
            $hst = round($amount * self::HST_RATE, 2);
            $total = round($amount + $hst, 2);
        }

        if ($t->comm_adjust_enabled) {
            $adjB = (float) $t->comm_adjust_before;
            $adjA = (float) $t->comm_adjust_after;
            if ($adjB != 0.0) {
                $commission = round($commission - $adjB, 2);
                $hst = round($commission * self::HST_RATE, 2);
                $total = round($commission + $hst, 2);
            }
            if ($adjA != 0.0) {
                $total = round($total - $adjA, 2);
            }
        }

        // Per-term breakdown
        $count = (int) $t->precon_term_count;
        if ($count < 1) {
            $count = 0;
        }
        $termRows = ($t->relationLoaded('preconTerms') ? $t->preconTerms : $t->preconTerms()->get())->keyBy('term_no');
        $members = $this->resolveMembers($t);

        $terms = [];
        $sumPct = 0.0;
        for ($k = 1; $k <= $count; $k++) {
            $row = $termRows->get($k);
            $tpct = $row ? (float) $row->pct : 0.0;
            $sumPct += $tpct;
            $tAmt = round($price * $tpct / 100, 2);
            $tHst = round($tAmt * self::HST_RATE, 2);
            $tTotal = $netHst ? $tAmt : round($tAmt + $tHst, 2);

            $visible = $members->filter(fn (TeamMember $m) => $this->visibleAtTerm($m, $k))->values();

            $terms[] = [
                'term_no' => $k,
                'pct' => $tpct,
                'closing_date' => $row && $row->closing_date ? $row->closing_date->toDateString() : null,
                'commission' => $tAmt,
                'hst' => $tHst,
                'total' => $tTotal,
                'agents' => $this->agentLines($visible, $tAmt, $t->adjustments ?? [], $k),
            ];
        }

        $masterPct = (float) $t->precon_comm_pct;
        $termsPctValid = $masterPct <= 0 ? true : ($sumPct <= $masterPct + 1e-9);

        return [
            'variant' => 'precon',
            'net_of_hst' => $netHst,
            'master' => [
                'pct' => $masterPct,
                'amount' => $amount,
                'commission' => $commission,
                'hst' => $hst,
                'total' => $total,
            ],
            'adjust' => [
                'enabled' => (bool) $t->comm_adjust_enabled,
                'before' => (float) $t->comm_adjust_before,
                'after' => (float) $t->comm_adjust_after,
            ],
            'term_count' => $count,
            'terms' => $terms,
            'terms_pct_valid' => $termsPctValid,
            'min_brokerage' => ['commission' => 200.0, 'hst' => 26.0, 'total' => 226.0],
        ];
    }

    private function visibleAtTerm(TeamMember $m, int $k): bool
    {
        if (($m->scope ?? 'Entire') === 'Entire') {
            return true;
        }
        $terms = $m->relationLoaded('terms') ? $m->terms : $m->terms()->get();

        return $terms->contains('term_no', $k);
    }

    /** Standard buying/lease variant — ports recalcFin() + recalcAgentComm(). */
    private function breakdownStandard(Transaction $t): array
    {
        $base = $this->grossBase($t);

        $adjBefore = $t->comm_adjust_enabled ? (float) $t->comm_adjust_before : 0.0;
        $adjAfter = $t->comm_adjust_enabled ? (float) $t->comm_adjust_after : 0.0;

        $commission = round($base - $adjBefore, 2);
        $hst = round($commission * self::HST_RATE, 2);
        $total = round($commission + $hst - $adjAfter, 2);

        return [
            'variant' => 'standard',
            'base_commission' => $base,
            'commission' => $commission,
            'hst' => $hst,
            'total' => $total,
            'adjust' => [
                'enabled' => (bool) $t->comm_adjust_enabled,
                'before' => (float) $t->comm_adjust_before,
                'after' => (float) $t->comm_adjust_after,
            ],
            'agents' => $this->agentLines($this->resolveMembers($t), $commission, $t->adjustments ?? []),
            'min_brokerage' => ['commission' => 200.0, 'hst' => 26.0, 'total' => 226.0],
        ];
    }

    /**
     * Listing variant — separate listing-side and co-op-side commission, each
     * with its own optional adjustment, then a combined total. Per-agent splits
     * apply to the combined commission. Ports recalcFinListing(). Min brokerage
     * floor for listings is $499 / $563.87.
     */
    private function breakdownListing(Transaction $t): array
    {
        $price = (float) $t->price;

        $side = function (float $pct, bool $adjEnabled, float $adjBefore, float $adjAfter) use ($price) {
            $amount = round($price * $pct / 100, 2);
            $before = $adjEnabled ? $adjBefore : 0.0;
            $after = $adjEnabled ? $adjAfter : 0.0;
            $commission = round($amount - $before, 2);
            $hst = round($commission * self::HST_RATE, 2);
            $total = round($commission + $hst - $after, 2);

            return compact('pct', 'amount', 'commission', 'hst', 'total');
        };

        $listing = $side((float) $t->listing_comm_pct, (bool) $t->listing_adj_enabled, (float) $t->listing_adj_before, (float) $t->listing_adj_after);
        $coop = $side((float) $t->coop_comm_pct, (bool) $t->coop_adj_enabled, (float) $t->coop_adj_before, (float) $t->coop_adj_after);

        $commission = round($listing['commission'] + $coop['commission'], 2);
        $hst = round($listing['hst'] + $coop['hst'], 2);
        $total = round($listing['total'] + $coop['total'], 2);

        return [
            'variant' => 'listing',
            'listing' => $listing,
            'coop' => $coop,
            'totals' => ['commission' => $commission, 'hst' => $hst, 'total' => $total],
            'adjust' => [
                'listing' => ['enabled' => (bool) $t->listing_adj_enabled, 'before' => (float) $t->listing_adj_before, 'after' => (float) $t->listing_adj_after],
                'coop' => ['enabled' => (bool) $t->coop_adj_enabled, 'before' => (float) $t->coop_adj_before, 'after' => (float) $t->coop_adj_after],
            ],
            'agents' => $this->agentLines($this->resolveMembers($t), $commission, $t->adjustments ?? []),
            'min_brokerage' => ['commission' => 499.0, 'hst' => 64.87, 'total' => 563.87],
        ];
    }

    /** Real team members, or a synthetic 100% primary when only an agent is set. */
    private function resolveMembers(Transaction $t)
    {
        $members = $t->relationLoaded('teamMembers') ? $t->teamMembers : $t->teamMembers()->get();
        if ($members->isEmpty() && $t->agent) {
            $members = collect([new TeamMember(['name' => $t->agent, 'split' => 100, 'agent_pct' => 90, 'brok_pct' => 10])]);
        }

        return $members;
    }

    /**
     * Per-member agent / brokerage / T4A lines off a commission base (woHst).
     * Agent adjustments (see memberDeduction) come off the Agent Commission Total
     * (Commission + HST) only — the Commission/HST and the T4A line stay gross.
     */
    private function agentLines($members, float $commissionWoHst, array $adjustments = [], ?int $term = null): array
    {
        $line = fn ($wo) => [
            'commission' => $wo,
            'hst' => round($wo * self::HST_RATE, 2),
            'total' => round($wo * (1 + self::HST_RATE), 2),
        ];

        return $members->map(function (TeamMember $m) use ($commissionWoHst, $line, $adjustments, $term) {
            $memberWoHst = round($commissionWoHst * ((float) $m->split) / 100, 2);
            $agentWoHst = round($memberWoHst * ((float) $m->agent_pct) / 100, 2);
            $brokWoHst = round($memberWoHst * ((float) $m->brok_pct) / 100, 2);

            $deduction = $this->memberDeduction($adjustments, $m, $term);

            return [
                'name' => $m->name,
                'split' => (float) $m->split,
                'agent_pct' => (float) $m->agent_pct,
                'brok_pct' => (float) $m->brok_pct,
                'adjustment' => $deduction,
                'agent' => [
                    'commission' => $agentWoHst,
                    'hst' => round($agentWoHst * self::HST_RATE, 2),
                    'total' => round($agentWoHst * (1 + self::HST_RATE) - $deduction, 2),
                ],
                'brokerage' => $line($brokWoHst),
                't4a' => $line($agentWoHst),
            ];
        })->values()->all();
    }

    /**
     * Pre-HST dollar deduction to apply to a member's Agent Commission, from the
     * Adjustment & Advance Payment module:
     *   • Agent Adjust + Advance Payment rows → matched to the member by name
     *   • Client Referral + External Brokerage Referral → pooled, shared by split %
     * For preconstruction (term given) only term-scoped rows apply and the
     * (term-less) pooled referrals are skipped. Status is ignored. Mirrors the
     * frontend agentAdjustments() helper.
     */
    private function memberDeduction(array $adj, TeamMember $m, ?int $term): float
    {
        if (empty($adj)) {
            return 0.0;
        }
        $sum = 0.0;
        $name = $m->name;

        if (($adj['agent_adjust'] ?? 'No') === 'Yes') {
            foreach ($adj['adjustment_rows'] ?? [] as $r) {
                if ($term !== null && (int) ($r['term'] ?? 0) !== $term) {
                    continue;
                }
                if (($r['agent'] ?? null) === $name) {
                    $sum += $this->n($r['amount'] ?? 0);
                }
            }
        }
        if (($adj['advance_payment'] ?? 'No') === 'Yes') {
            foreach ($adj['advance_rows'] ?? [] as $r) {
                if ($term !== null && (int) ($r['term'] ?? 0) !== $term) {
                    continue;
                }
                if (($r['agent'] ?? null) === $name) {
                    $sum += $this->n($r['amount'] ?? 0);
                }
            }
        }

        // Pooled referrals (no agent / term attribution) shared by split %.
        if ($term === null) {
            $pooled = 0.0;
            if (($adj['client_referral'] ?? 'No') === 'Yes') {
                foreach ($adj['client_rows'] ?? [] as $r) {
                    $pooled += $this->n($r['amount'] ?? 0);
                }
            }
            if (($adj['ext_referral'] ?? 'No') === 'Yes') {
                $pooled += $this->n($adj['ext']['amount'] ?? 0);
            }
            if ($pooled != 0.0) {
                $sum += $pooled * ((float) $m->split / 100);
            }
        }

        return round($sum, 2);
    }

    private function n($v): float
    {
        return is_numeric($v) ? (float) $v : 0.0;
    }
}
