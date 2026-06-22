<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->string('precon_listing_type')->default('mls')->after('coop_adj_after'); // mls | builder
            $table->unsignedInteger('precon_term_count')->nullable()->after('precon_listing_type');
            $table->string('commission_agent')->nullable()->after('precon_term_count');
            $table->boolean('precon_net_of_hst')->default(false)->after('commission_agent');
            $table->decimal('precon_comm_pct', 8, 4)->nullable()->after('precon_net_of_hst');
            $table->decimal('precon_comm_amt_manual', 15, 2)->nullable()->after('precon_comm_pct');
            $table->string('precon_details_of_terms')->default('Entire')->after('precon_comm_amt_manual'); // Entire | "Term N"

            // Builder Information card
            $table->string('builder_name')->nullable()->after('precon_details_of_terms');
            $table->string('builder_vendor')->nullable()->after('builder_name');
            $table->string('builder_project')->nullable()->after('builder_vendor');
            $table->string('builder_address')->nullable()->after('builder_project');
            $table->string('builder_office_email')->nullable()->after('builder_address');
            $table->string('builder_invoice_email')->nullable()->after('builder_office_email');
            $table->string('builder_phone')->nullable()->after('builder_invoice_email');
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn([
                'precon_listing_type', 'precon_term_count', 'commission_agent',
                'precon_net_of_hst', 'precon_comm_pct', 'precon_comm_amt_manual', 'precon_details_of_terms',
                'builder_name', 'builder_vendor', 'builder_project', 'builder_address',
                'builder_office_email', 'builder_invoice_email', 'builder_phone',
            ]);
        });
    }
};
