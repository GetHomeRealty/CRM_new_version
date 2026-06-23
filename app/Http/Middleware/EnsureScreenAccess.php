<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class EnsureScreenAccess
{
    /** Usage: ->middleware('screen:transactions,edit') */
    public function handle(Request $request, Closure $next, string $screen, string $level = 'view'): Response
    {
        abort_unless(
            $request->user() && $request->user()->canScreen($screen, $level),
            403,
            "You don't have permission to perform this action."
        );

        return $next($request);
    }
}
