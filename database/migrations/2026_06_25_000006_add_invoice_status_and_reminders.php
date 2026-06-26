<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Invoice §12.2/§12.3 — commission-received details (shown when status = Paid) and
 * reminder tracking: `reminders` = sent history [dates], `auto_reminder` = the
 * chosen cadence/custom-dates config. All additive/nullable.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('invoices', function (Blueprint $table) {
            $table->date('commission_received_date')->nullable()->after('discount');
            $table->string('commission_received_via')->nullable()->after('commission_received_date');
            $table->json('reminders')->nullable()->after('commission_received_via');
            $table->json('auto_reminder')->nullable()->after('reminders');
        });
    }

    public function down(): void
    {
        Schema::table('invoices', function (Blueprint $table) {
            $table->dropColumn(['commission_received_date', 'commission_received_via', 'reminders', 'auto_reminder']);
        });
    }
};
