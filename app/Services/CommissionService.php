<?php

namespace App\Services;

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
}
