<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /** Timestamp of the last Trade Record Sheet email (drives the Send / Resend label). */
    public function up(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->timestamp('trade_sheet_sent_at')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn('trade_sheet_sent_at');
        });
    }
};
