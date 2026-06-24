<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Commercial-lease calculator inputs (Lease Structure, Rent & Escalation,
        // Commission Inputs). Computed schedules/commission tables are derived
        // client-side; only the inputs persist. Freeform JSON — additive, only
        // populated for commercial lease types.
        Schema::table('transactions', function (Blueprint $table) {
            $table->json('commercial_lease')->nullable()->after('adjustments');
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn('commercial_lease');
        });
    }
};
