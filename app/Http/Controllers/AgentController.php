<?php

namespace App\Http\Controllers;

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
}
