<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            // Manual "Payable to Client" entry for the listing Trust Verification check.
            $table->decimal('trust_payable', 15, 2)->nullable()->after('coop_comm_flat');
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn('trust_payable');
        });
    }
};
