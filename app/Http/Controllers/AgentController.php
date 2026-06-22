<?php

namespace App\Http\Controllers;

use App\Models\Agent;

class AgentController extends Controller
{
    /** Agent directory for the name datalists/autocomplete. */
    public function index()
    {
        return response()->json(
            Agent::where('active', true)->orderBy('name')->pluck('name')
        );
    }
}
