<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Transaction Desk v2 — Phase 0. Adds a per-install feature-flag bag so the new
 * Transaction Desk behaviours can be toggled (and instantly rolled back) without
 * a code deploy. Additive only; existing rows are untouched.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('company_settings', function (Blueprint $table) {
            $table->json('feature_flags')->nullable()->after('id');
        });

        // Default: new Transaction Desk behaviours ON; flip to false to roll back.
        DB::table('company_settings')->whereNull('feature_flags')
            ->update(['feature_flags' => json_encode(['transaction_desk_v2' => true])]);
    }

    public function down(): void
    {
        Schema::table('company_settings', function (Blueprint $table) {
            $table->dropColumn('feature_flags');
        });
    }
};
