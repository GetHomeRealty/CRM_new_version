<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Notice of Sale editable data: per-document buyer / seller name overrides, the
 * document date, and per-salesperson signatures + signed/sent timestamps. Stored
 * as a single JSON blob so it stays decoupled from the core transaction fields.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->json('notice_of_sale')->nullable()->after('commercial_lease');
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn('notice_of_sale');
        });
    }
};
