<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * §12.5 — link each preconstruction term invoice to its term, so Admin Activities
 * can show per-term invoice number/status. Additive/nullable; existing invoices
 * (normal transactions) leave term_no null.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('invoices', function (Blueprint $table) {
            $table->unsignedInteger('term_no')->nullable()->after('transaction_type');
        });
    }

    public function down(): void
    {
        Schema::table('invoices', function (Blueprint $table) {
            $table->dropColumn('term_no');
        });
    }
};
