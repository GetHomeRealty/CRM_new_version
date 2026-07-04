<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->decimal('listing_comm_flat', 15, 2)->nullable()->after('coop_comm_pct');
            $table->decimal('coop_comm_flat', 15, 2)->nullable()->after('listing_comm_flat');
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn(['listing_comm_flat', 'coop_comm_flat']);
        });
    }
};
