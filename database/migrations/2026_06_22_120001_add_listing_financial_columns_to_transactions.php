<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            // Listing Financial variant: separate listing-side and co-op-side commission.
            $table->decimal('listing_comm_pct', 8, 4)->nullable()->after('comm_adjust_after');
            $table->decimal('coop_comm_pct', 8, 4)->nullable()->after('listing_comm_pct');

            $table->boolean('listing_adj_enabled')->default(false)->after('coop_comm_pct');
            $table->decimal('listing_adj_before', 15, 2)->default(0)->after('listing_adj_enabled');
            $table->decimal('listing_adj_after', 15, 2)->default(0)->after('listing_adj_before');

            $table->boolean('coop_adj_enabled')->default(false)->after('listing_adj_after');
            $table->decimal('coop_adj_before', 15, 2)->default(0)->after('coop_adj_enabled');
            $table->decimal('coop_adj_after', 15, 2)->default(0)->after('coop_adj_before');
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn([
                'listing_comm_pct', 'coop_comm_pct',
                'listing_adj_enabled', 'listing_adj_before', 'listing_adj_after',
                'coop_adj_enabled', 'coop_adj_before', 'coop_adj_after',
            ]);
        });
    }
};
