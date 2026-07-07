<?php

namespace App\Http\Controllers;

use App\Models\AuditLog;
use App\Services\PermissionService;
use Illuminate\Http\Request;

/**
 * Global, cross-module audit trail. Aggregates module-level activity (Users,
 * Settings, Invoice, …) and per-transaction changes into one filterable feed.
 */
class AuditLogController extends Controller
{
    public function index(Request $request)
    {
        $q = AuditLog::query()->with('transaction:id,trade_no')->latest();

        // Agent-made transaction changes are already shown in each transaction's own
        // audit trail — keep them out of the global feed.
        $q->where(function ($w) {
            $w->whereNull('transaction_id')
                ->orWhereNull('source')
                ->orWhere('source', '!=', 'Agent');
        });

        if ($cat = $request->query('category')) {
            $cat === 'Transactions'
                ? $q->whereNotNull('transaction_id')
                : $q->where('category', $cat);
        }
        if ($uid = $request->query('user_id')) {
            $q->where('user_id', $uid);
        }
        if ($from = $request->query('from')) {
            $q->whereDate('created_at', '>=', $from);
        }
        if ($to = $request->query('to')) {
            $q->whereDate('created_at', '<=', $to);
        }
        if ($term = trim((string) $request->query('q', ''))) {
            $q->where(function ($w) use ($term) {
                foreach (['who', 'section', 'field', 'old_value', 'new_value', 'action', 'details'] as $c) {
                    $w->orWhere($c, 'like', "%{$term}%");
                }
            });
        }

        $page = $q->paginate(50);

        return response()->json([
            'data' => collect($page->items())->map(fn (AuditLog $a) => [
                'id' => $a->id,
                'category' => $a->category ?: ($a->transaction_id ? 'Transactions' : 'General'),
                'record' => $a->transaction ? ('Trade #'.$a->transaction->trade_no) : null,
                'transaction_id' => $a->transaction_id,
                'who' => $a->who,
                'section' => $a->section,
                'field' => $a->field,
                'action' => $a->action,
                'source' => $a->source,
                'old_value' => $a->old_value,
                'new_value' => $a->new_value,
                'details' => $a->details,
                'stamp' => $a->created_at?->toDateTimeString(),
            ]),
            'meta' => [
                'current_page' => $page->currentPage(),
                'last_page' => $page->lastPage(),
                'total' => $page->total(),
            ],
            'categories' => array_values(PermissionService::SCREENS),
        ]);
    }
}
