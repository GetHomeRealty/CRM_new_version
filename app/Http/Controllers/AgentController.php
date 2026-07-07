<?php

namespace App\Http\Controllers;

use App\Models\Transaction;
use App\Models\User;

class AgentController extends Controller
{
    /** Agent directory for the name datalists/autocomplete — only active Agent users. */
    public function index()
    {
        return response()->json(
            User::where('role', 'agent')
                ->where(fn ($q) => $q->where('status', 'Active')->orWhereNull('status'))
                ->orderBy('name')
                ->pluck('name')
        );
    }

    /**
     * Map of agent name => their registered default commission split, taken from
     * the user profile (Current Agent Commission % + lease %). Used to pre-fill
     * Agent Comm (%) on transactions and to flag transaction-specific overrides.
     */
    /** Map of agent/user name => email, for CC-ing listing agents on documents. */
    public function emails()
    {
        $map = [];
        foreach (User::all(['name', 'email']) as $u) {
            if ($u->email) {
                $map[$u->name] = $u->email;
            }
        }

        return response()->json($map);
    }

    public function commissions()
    {
        $map = [];
        foreach (User::all(['name', 'profile']) as $u) {
            $p = $u->profile ?? [];
            $agent = $p['agent_comm_pct'] ?? null;
            if ($agent === null || $agent === '') {
                continue;
            }
            $lease = $p['lease_comm_pct'] ?? null;
            $map[$u->name] = [
                'agent_pct' => (float) $agent,
                'lease_pct' => ($lease === null || $lease === '') ? null : (float) $lease,
            ];
        }

        return response()->json($map);
    }

    /**
     * Per-agent loan position: the actual loan the agent carries (from their user
     * profile) minus every adjustment across all their deals that was marked as a
     * loan repayment. Powers the loan reminder in Financial Information and the
     * "Balance Loan Amount" field in Users. Map of name => {loan_amount,
     * loan_repaid, loan_balance, repayments[]}; only agents with an outstanding
     * loan appear. `repayments` lists which deal each repayment came from.
     */
    public function loans()
    {
        $loans = [];
        foreach (User::all(['name', 'profile']) as $u) {
            $p = $u->profile ?? [];
            $amount = (float) str_replace(',', '', (string) ($p['loan_amount'] ?? 0));
            if (! empty($p['has_loan']) && $amount > 0) {
                $loans[$u->name] = ['loan_amount' => $amount, 'loan_repaid' => 0.0, 'repayments' => []];
            }
        }

        if ($loans) {
            foreach (Transaction::whereNotNull('adjustments')->get(['id', 'trade_no', 'property', 'closing_date', 'adjustments']) as $t) {
                foreach (($t->adjustments['adjustment_rows'] ?? []) as $r) {
                    if (empty($r['is_loan'])) {
                        continue;
                    }
                    $name = $r['agent'] ?? null;
                    if ($name === null || ! isset($loans[$name])) {
                        continue;
                    }
                    // Loan repayments are stored as a positive deduction (see the
                    // SignedAmount "−" convention); only those reduce the balance.
                    $amt = (float) str_replace(',', '', (string) ($r['amount'] ?? 0));
                    if ($amt > 0) {
                        $loans[$name]['loan_repaid'] += $amt;
                        $loans[$name]['repayments'][] = [
                            'trade_no' => $t->trade_no,
                            'property' => $t->property,
                            'closing_date' => optional($t->closing_date)->toDateString(),
                            'amount' => round($amt, 2),
                        ];
                    }
                }
            }
        }

        $out = [];
        foreach ($loans as $name => $v) {
            $out[$name] = [
                'loan_amount' => round($v['loan_amount'], 2),
                'loan_repaid' => round($v['loan_repaid'], 2),
                'loan_balance' => max(0, round($v['loan_amount'] - $v['loan_repaid'], 2)),
                'repayments' => $v['repayments'],
            ];
        }

        return response()->json($out);
    }
}
