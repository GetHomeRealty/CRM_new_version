<?php

namespace App\Http\Controllers;

use App\Models\Agent;
use App\Models\User;

class AgentController extends Controller
{
    /** Agent directory for the name datalists/autocomplete. */
    public function index()
    {
        return response()->json(
            Agent::where('active', true)->orderBy('name')->pluck('name')
        );
    }

    /**
     * Map of agent name => their registered default commission split, taken from
     * the user profile (Current Agent Commission % + lease %). Used to pre-fill
     * Agent Comm (%) on transactions and to flag transaction-specific overrides.
     */
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
