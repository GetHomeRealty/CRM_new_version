<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Transaction Desk v2 — Phase 1. "Hold" is removed entirely from the status
 * vocabulary. Existing rows holding "Hold" are remapped to "Open" (de-duping if
 * the transaction already has an "Open" row).
 *
 * Rollback note: this is a one-way data fix — down() cannot know which "Open"
 * rows were originally "Hold", so it is a no-op. "Hold" is deprecated and must
 * not return.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! DB::getSchemaBuilder()->hasTable('transaction_statuses')) {
            return;
        }

        // Drop Hold rows where the transaction already has Open (avoid duplicates)…
        $dupes = DB::table('transaction_statuses as h')
            ->join('transaction_statuses as o', function ($j) {
                $j->on('h.transaction_id', '=', 'o.transaction_id')->where('o.status', '=', 'Open');
            })
            ->where('h.status', 'Hold')
            ->pluck('h.id');
        if ($dupes->isNotEmpty()) {
            DB::table('transaction_statuses')->whereIn('id', $dupes)->delete();
        }

        // …then convert the remaining Hold rows to Open.
        DB::table('transaction_statuses')->where('status', 'Hold')->update(['status' => 'Open']);
    }

    public function down(): void
    {
        // Intentionally irreversible — "Hold" is deprecated.
    }
};
