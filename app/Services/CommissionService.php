<?php

namespace App\Services;

use App\Models\TeamMember;
use App\Models\Transaction;
use App\Models\User;

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
        $amount = round($this->grossCommission($t), 2);
        $hst = round($amount * self::HST_RATE, 2);
        $total = round($amount + $hst, 2);

        $paid = $t->comm_paid_status === 'Yes' || $t->comm_status === 'Received';

        return compact('amount', 'hst', 'total', 'paid');
    }

    /** Gross commission for a transaction, by type (listing / precon / standard). */
    private function grossCommission(Transaction $t): float
    {
        $price = (float) $t->price;

        // Preconstruction: manual amount, else master % of price.
        if (Transaction::isPreconType($t->type)) {
            $manual = $t->precon_comm_amt_manual;
            if ($manual !== null && (float) $manual > 0) {
                return (float) $manual;
            }

            return $price * (float) $t->precon_comm_pct / 100;
        }

        // Listing side: listing + co-op commission (percent and/or flat).
        if (Transaction::isListingFinancialType($t->type)) {
            $list = $price * (float) $t->listing_comm_pct / 100 + (float) $t->listing_comm_flat;
            $coop = $price * (float) $t->coop_comm_pct / 100 + (float) $t->coop_comm_flat;

            return $list + $coop;
        }

        // Standard buying / lease.
        if ($t->comm_amt !== null && (float) $t->comm_amt > 0) {
            return (float) $t->comm_amt;
        }
        if ($t->comm_pct !== null && (float) $t->comm_pct > 0) {
            return $price * (float) $t->comm_pct / 100;
        }
        if ($t->comm_type === '%' && (float) $t->comm_value > 0) {
            return $price * (float) $t->comm_value / 100;
        }
        if ($t->comm_type === 'Fixed' && (float) $t->comm_value > 0) {
            return (float) $t->comm_value;
        }

        return 0.0;
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

        // Deal-level referrals: broker referral reduces the commission base that
        // feeds the team split; client referral comes off the deal Total only.
        $adj = $t->adjustments ?? [];
        $members = $this->resolveMembers($t);
        $splitBase = round($commission - $this->brokerReferralAmount($adj), 2);
        // "Agent Commissions after client referral" is computed off the commission AFTER the
        // external broker referral ($splitBase = commission − broker referral).
        $afterClient = $this->agentCommissionsAfterClient($splitBase, $members, 200.0, $adjBefore, $adjAfter, $this->clientReferralAmount($adj));
        $agentCtx = [
            'acComm' => $afterClient['commission'],
            'acTotal' => $afterClient['total'],
            'minBrokComm' => 200.0,
            'adjBefore' => $adjBefore,
            'adjAfter' => $adjAfter,
        ];

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
            'referrals' => $this->referralSections($base, $adj, $afterClient),
            'agents' => $this->agentLines($members, $splitBase, $adj, null, $agentCtx),
            'min_brokerage' => ['commission' => 200.0, 'hst' => 26.0, 'total' => 226.0],
        ];
    }

    /**
     * Listing variant — separate listing-side and co-op-side commission, each
     * with its own optional adjustment, then a combined total. Per-agent splits
     * apply to the combined commission. Min brokerage floor $499 sale / $250 lease.
     */
    private function breakdownListing(Transaction $t): array
    {
        $hst = self::HST_RATE;
        $g = 1 + $hst;
        $price = (float) $t->price;
        $deposit = (float) $t->deposit;
        $isLease = (bool) preg_match('/lease/i', (string) $t->type);
        $minBrok = $isLease ? 250.0 : 499.0;

        $listPct = (float) $t->listing_comm_pct;
        $coopPct = (float) $t->coop_comm_pct;
        $listFlat = (float) $t->listing_comm_flat; // fixed-amount alternative to the %
        $coopFlat = (float) $t->coop_comm_flat;
        $lAdjBefore = $t->listing_adj_enabled ? (float) $t->listing_adj_before : 0.0;
        $lAdjAfter = $t->listing_adj_enabled ? (float) $t->listing_adj_after : 0.0;
        $cAdjBefore = $t->coop_adj_enabled ? (float) $t->coop_adj_before : 0.0;
        $cAdjAfter = $t->coop_adj_enabled ? (float) $t->coop_adj_after : 0.0;

        $adj = $t->adjustments ?? [];
        $extAmt = $this->brokerReferralAmount($adj);
        $clientReferral = $this->clientReferralAmount($adj);
        $members = $this->resolveMembers($t);
        $first = $members->first();
        $agentSplit = $first ? (float) $first->agent_pct / 100 : ($isLease ? 0.95 : 0.90);
        $brokerageSplit = 1 - $agentSplit;

        $listBasePct = $price * $listPct / 100;
        $coopBasePct = $price * $coopPct / 100;

        // Step 1 — external referral (off the listing side)
        $extHst = $extAmt * $hst;
        $extTotal = $extAmt + $extHst;

        $allZero = $listPct == 0.0 && $listFlat == 0.0 && $coopPct == 0.0 && $coopFlat == 0.0;

        // Sale & Lease share the same listing/co-op/split math — adjustments apply to their
        // own sides (listing adj → listing, co-op adj → co-op). Lease differs ONLY in the min
        // brokerage floor ($250) and the trust floor (payable not floored at 0). The external
        // broker referral never touches the Listing Commission (handled in referralSections).
        $listComm = $listBasePct + $listFlat + $lAdjBefore;
        $listHst = $listComm * $hst;
        $listTotal = ($listComm + $listHst) + $lAdjAfter;
        $coopComm = $coopBasePct + $coopFlat + $cAdjBefore;
        $coopHst = $coopComm * $hst;
        $coopTotal = ($coopComm + $coopHst) + $cAdjAfter;
        $totalComm = $allZero ? 0.0 : $listBasePct + $coopBasePct + $listFlat + $coopFlat + $lAdjBefore + $cAdjBefore;
        $totalHst = $totalComm * $hst;
        $totalWithHst = ($totalComm + $totalHst) + $lAdjAfter + $cAdjAfter;
        $payableToClient = $isLease ? ($deposit - $totalWithHst) : max($deposit - $totalWithHst, 0);
        $receivableFromLawyer = min($deposit - $totalWithHst, 0);
        // The agent/brokerage split (and agent commissions) are computed on the commission
        // AFTER the external broker referral; the external broker is paid out separately.
        $splitTotal = round($listTotal - $extAmt * $g, 2);
        $brokerageFloor = max($splitTotal * $brokerageSplit, $minBrok * $g);
        $agentPool = max(min($splitTotal * $agentSplit, $splitTotal - $brokerageFloor), 0);
        $brokerageKeep = $splitTotal - $agentPool;

        // Step 7 — per member; also build a backward-compatible `agents` array.
        $line = fn ($wo) => ['commission' => round($wo, 2), 'hst' => round($wo * $hst, 2), 'total' => round($wo * $g, 2)];
        $memberRows = [];
        $agents = [];
        foreach ($members as $m) {
            $teamShare = (float) $m->split / 100;
            $earned = ($agentPool - $clientReferral) * $teamShare; // HST-inclusive (T4A amount)
            $commission = $earned / $g;
            $mHst = $commission * $hst;
            $advance = $this->memberAdvance($adj, $m->name);
            $deduction = $this->memberDeduction($adj, $m, null); // Agent Adjust + Advance
            $cashToPay = $earned - $deduction;
            $brokFromMember = $brokerageKeep * $teamShare;

            $memberRows[] = [
                'name' => $m->name,
                'team_share' => $teamShare,
                'commission' => round($commission, 2),
                'hst' => round($mHst, 2),
                'earned' => round($earned, 2),
                'advance' => round($advance, 2),
                'deduction' => round($deduction, 2),
                'cash_to_pay' => round($cashToPay, 2),
                'brokerage_from_member' => round($brokFromMember, 2),
            ];
            $agents[] = [
                'name' => $m->name,
                'split' => (float) $m->split,
                'agent_pct' => (float) $m->agent_pct,
                'brok_pct' => (float) $m->brok_pct,
                'agent' => ['commission' => round($commission, 2), 'hst' => round($mHst, 2), 'total' => round($earned, 2)],
                'brokerage' => $line($brokFromMember / $g),
                't4a' => ['commission' => round($commission, 2), 'hst' => round($mHst, 2), 'total' => round($earned, 2)],
            ];
        }

        // Step 9 — balance check
        $sumCash = array_sum(array_column($memberRows, 'cash_to_pay'));
        $sumDeduction = array_sum(array_column($memberRows, 'deduction'));
        $coopPayout = $coopTotal;
        $reconcile = $coopPayout + round($extAmt * $g, 2) + $clientReferral + $sumCash + $brokerageKeep + $sumDeduction;

        // Referral sections are based on the (fixed) Listing Commission — the broker referral
        // only changes "Commissions after broker referral", never the Listing Commission itself.
        // Agent commissions are computed off the commission AFTER the external broker referral.
        $listAfterBrokerComm = round($listComm - $this->brokerReferralAmount($adj), 2);
        $afterClient = $this->agentCommissionsAfterClient($listAfterBrokerComm, $members, 499.0, $lAdjBefore, $lAdjAfter, $clientReferral);

        return [
            'variant' => 'listing',
            'referrals' => $this->referralSections($listComm, $adj, $afterClient),
            'deal_type' => $isLease ? 'Lease' : 'Sale',
            'listing' => ['pct' => $listPct, 'commission' => round($listComm, 2), 'hst' => round($listHst, 2), 'total' => round($listTotal, 2)],
            'coop' => ['pct' => $coopPct, 'commission' => round($coopComm, 2), 'hst' => round($coopHst, 2), 'total' => round($coopTotal, 2)],
            'totals' => ['commission' => round($totalComm, 2), 'hst' => round($totalHst, 2), 'total' => round($totalWithHst, 2)],
            'ext_referral' => ['amount' => round($extAmt, 2), 'hst' => round($extHst, 2), 'total' => round($extTotal, 2)],
            'trust' => ['deposit' => round($deposit, 2), 'payable_to_client' => round($payableToClient, 2), 'receivable_from_lawyer' => round($receivableFromLawyer, 2)],
            'coop_payout' => round($coopPayout, 2),
            'split' => ['agent_split' => $agentSplit, 'brokerage_split' => $brokerageSplit, 'agent_pool' => round($agentPool, 2), 'brokerage_keep' => round($brokerageKeep, 2), 'brokerage_floor' => round($brokerageFloor, 2)],
            'client_referral' => round($clientReferral, 2),
            'members' => $memberRows,
            'brokerage_keep' => round($brokerageKeep, 2),
            'adjust' => [
                'listing' => ['enabled' => (bool) $t->listing_adj_enabled, 'before' => (float) $t->listing_adj_before, 'after' => (float) $t->listing_adj_after],
                'coop' => ['enabled' => (bool) $t->coop_adj_enabled, 'before' => (float) $t->coop_adj_before, 'after' => (float) $t->coop_adj_after],
            ],
            'agents' => $agents,
            'min_brokerage' => ['commission' => $minBrok, 'hst' => round($minBrok * $hst, 2), 'total' => round($minBrok * $g, 2)],
            'balance_check' => ['expected' => round($totalWithHst, 2), 'reconcile' => round($reconcile, 2), 'pass' => abs($reconcile - $totalWithHst) < 0.05],
        ];
    }

    /** Real team members, or a synthetic 100% primary when only an agent is set. */
    private function resolveMembers(Transaction $t)
    {
        $members = $t->relationLoaded('teamMembers') ? $t->teamMembers : $t->teamMembers()->get();
        if ($members->isEmpty() && $t->agent) {
            // Apply the agent's registered split (from their User profile) to the deal.
            $split = $this->agentDefaultSplit($t->agent, $t->type);
            $members = collect([new TeamMember([
                'name' => $t->agent, 'split' => 100,
                'agent_pct' => $split['agent'], 'brok_pct' => $split['brok'],
            ])]);
        }

        return $members;
    }

    /**
     * The agent / brokerage split registered for an agent in their User profile.
     * Lease deals use the lease % (default 95); buying/sale use the agent % (default 90).
     */
    private function agentDefaultSplit(?string $name, ?string $type): array
    {
        $isLease = (bool) preg_match('/lease/i', (string) $type);
        $agent = $isLease ? 95.0 : 90.0;

        if ($name) {
            $u = User::where('name', $name)->first(['profile']);
            $p = $u?->profile ?? [];
            $v = $p[$isLease ? 'lease_comm_pct' : 'agent_comm_pct'] ?? null;
            if ($v !== null && $v !== '') {
                $agent = (float) $v;
            }
        }

        return ['agent' => $agent, 'brok' => round(100 - $agent, 2)];
    }

    /**
     * Per-member agent / brokerage / T4A lines off a commission base (woHst).
     * Brokerage and T4A are simple split×pct lines. The Agent Commission line uses
     * the brokerage-floor cap formula (agentCommissionLine) when $agentCtx is given
     * (standard/listing); otherwise (precon per term) it is the gross agent line
     * with the per-member adjustment taken off the Total.
     */
    private function agentLines($members, float $commissionWoHst, array $adjustments = [], ?int $term = null, ?array $agentCtx = null): array
    {
        $line = fn ($wo) => [
            'commission' => $wo,
            'hst' => round($wo * self::HST_RATE, 2),
            'total' => round($wo * (1 + self::HST_RATE), 2),
        ];

        return $members->map(function (TeamMember $m) use ($commissionWoHst, $line, $adjustments, $term, $agentCtx) {
            $memberWoHst = round($commissionWoHst * ((float) $m->split) / 100, 2);
            $agentWoHst = round($memberWoHst * ((float) $m->agent_pct) / 100, 2);
            $brokWoHst = round($memberWoHst * ((float) $m->brok_pct) / 100, 2);

            $deduction = $this->memberDeduction($adjustments, $m, $term);

            if ($agentCtx !== null) {
                $agent = $this->agentCommissionLine($m, $agentCtx, $deduction);
                $t4a = $this->agentCommissionLine($m, $agentCtx, 0.0); // gross (no per-agent deduction)
            } else {
                $agent = [
                    'commission' => $agentWoHst,
                    'hst' => round($agentWoHst * self::HST_RATE, 2),
                    'total' => round($agentWoHst * (1 + self::HST_RATE) - $deduction, 2),
                ];
                $t4a = $line($agentWoHst);
            }

            return [
                'name' => $m->name,
                'split' => (float) $m->split,
                'agent_pct' => (float) $m->agent_pct,
                'brok_pct' => (float) $m->brok_pct,
                'adjustment' => $deduction,
                'agent' => $agent,
                'brokerage' => $line($brokWoHst),
                't4a' => $t4a,
            ];
        })->values()->all();
    }

    /**
     * Per-member "Agent Commission" (payable, with HST). The Agent% / floor cap is
     * already applied in agentCommissionsAfterClient, so each member takes their
     * Split % of that section's Total, less this member's Adjustment + Advance.
     * Pass $deduction = 0 for the gross (T4A) line. Mirrors agentCommissionLine()
     * in commissionCalc.js. $ctx: ['acTotal' => ...].
     */
    private function agentCommissionLine(TeamMember $m, array $ctx, float $deduction): array
    {
        $g = 1 + self::HST_RATE;
        $split = (float) $m->split / 100;
        $total = round((float) ($ctx['acTotal'] ?? 0) * $split - $deduction, 2);
        $commission = round($total / $g, 2);
        $hst = round($total - $commission, 2);

        return ['commission' => $commission, 'hst' => $hst, 'total' => $total];
    }

    /**
     * Pre-HST dollar deduction to apply to a member's Agent Commission Total, from
     * the Adjustment & Advance Payment module — per-agent categories only:
     *   • Agent Adjust + Advance Payment rows → matched to the member by name
     * Client Referral + External Brokerage Referral are deal-level (see
     * referralSections), not per-agent. For preconstruction (term given) only
     * term-scoped rows apply. Status is ignored. Mirrors agentAdjustments().
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

        return round($sum, 2);
    }

    /** Advance already paid to a member (matched by name), from Advance Payments. */
    private function memberAdvance(array $adj, ?string $name): float
    {
        if (($adj['advance_payment'] ?? 'No') !== 'Yes' || $name === null) {
            return 0.0;
        }
        $sum = 0.0;
        foreach ($adj['advance_rows'] ?? [] as $r) {
            if (($r['agent'] ?? null) === $name) {
                $sum += $this->n($r['amount'] ?? 0);
            }
        }

        return $sum;
    }

    /** External brokerage referral amount (deal-level, pre-HST). */
    private function brokerReferralAmount(array $adj): float
    {
        return ($adj['ext_referral'] ?? 'No') === 'Yes' ? $this->n($adj['ext']['amount'] ?? 0) : 0.0;
    }

    /** Total client referral amount (deal-level, off Total). */
    private function clientReferralAmount(array $adj): float
    {
        if (($adj['client_referral'] ?? 'No') !== 'Yes') {
            return 0.0;
        }
        $sum = 0.0;
        foreach ($adj['client_rows'] ?? [] as $r) {
            $sum += $this->n($r['amount'] ?? 0);
        }

        return $sum;
    }

    /**
     * "Commissions after broker referral" section (full commission − broker
     * referral). The "Agent Commissions after client referral" section is passed
     * in via $afterClient (see agentCommissionsAfterClient). Returns null when
     * neither referral category is enabled. Mirrors the frontend helpers.
     */
    private function referralSections(float $dealComm, array $adj, ?array $afterClient = null): ?array
    {
        $showBroker = ($adj['ext_referral'] ?? 'No') === 'Yes';
        $showClient = ($adj['client_referral'] ?? 'No') === 'Yes';
        if (! $showBroker && ! $showClient) {
            return null;
        }
        $afterBrokerComm = round($dealComm - $this->brokerReferralAmount($adj), 2);
        $afterBroker = [
            'commission' => $afterBrokerComm,
            'hst' => round($afterBrokerComm * self::HST_RATE, 2),
            'total' => round($afterBrokerComm * (1 + self::HST_RATE), 2),
        ];

        return [
            'broker_amount' => round($this->brokerReferralAmount($adj), 2),
            'client_amount' => round($this->clientReferralAmount($adj), 2),
            'show_broker' => $showBroker,
            'show_client' => $showClient,
            'after_broker' => $afterBroker,
            'after_client' => $afterClient,
        ];
    }

    /**
     * "Agent Commissions after client referral" — sum across team members of each
     * member's brokerage-floor-capped agent commission off the listing-side
     * commission (Agent% and Brokerage% both weighted by the member's Split %),
     * minus the client referral. Mirrors agentCommissionsAfterClient() in
     * commissionCalc.js.
     */
    private function agentCommissionsAfterClient(float $lc, $members, float $minBrokComm, float $adjBefore, float $adjAfter, float $clientReferral): array
    {
        $g = 1 + self::HST_RATE;
        $minBrokTotal = $minBrokComm * $g;
        $pool = 0.0;
        foreach ($members as $m) {
            $a = (float) $m->agent_pct / 100;
            $b = (float) $m->brok_pct / 100;
            $split = (float) $m->split / 100;
            $brokRaw = max($lc * $b * $split, $minBrokTotal);
            $floor = $lc == 0.0 ? 0.0 : $brokRaw - ($adjBefore * $g - $adjAfter);
            $pool += max(0.0, min($lc * $a * $split, $lc - $floor));
        }
        // Client referral comes off the Total (with HST); commission is back-solved.
        $total = round($pool * $g - $clientReferral, 2);
        $commission = round($total / $g, 2);
        $hst = round($total - $commission, 2);

        return ['commission' => $commission, 'hst' => $hst, 'total' => $total];
    }

    private function n($v): float
    {
        return is_numeric($v) ? (float) $v : 0.0;
    }
}
