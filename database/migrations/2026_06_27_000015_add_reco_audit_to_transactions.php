<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * "Ready for RECO Audit" flag (Yes/No) shown in Legal & Documentation. When
     * "No" is chosen a remarks note explains why the file isn't audit-ready.
     */
    public function up(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->string('reco_audit_ready')->nullable();
            $table->text('reco_audit_remarks')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn(['reco_audit_ready', 'reco_audit_remarks']);
        });
    }
};
