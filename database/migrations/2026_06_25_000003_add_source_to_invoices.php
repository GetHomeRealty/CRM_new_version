<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Mark invoice origin so the list can clearly distinguish transaction-generated
 * invoices from manually-created ones. Additive + backfilled — existing invoices
 * keep working (defaults: source='manual', or 'transaction' when linked).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('invoices', function (Blueprint $table) {
            $table->string('source', 20)->default('manual')->after('transaction_id');
            $table->string('transaction_type')->nullable()->after('source');
            $table->unsignedBigInteger('created_by')->nullable()->after('transaction_type');
        });

        // Backfill existing rows: anything already linked to a transaction = 'transaction'.
        DB::table('invoices')->whereNotNull('transaction_id')->update(['source' => 'transaction']);
    }

    public function down(): void
    {
        Schema::table('invoices', function (Blueprint $table) {
            $table->dropColumn(['source', 'transaction_type', 'created_by']);
        });
    }
};
