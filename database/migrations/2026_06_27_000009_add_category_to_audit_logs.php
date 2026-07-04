<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Global audit trail: audit_logs can now record module-level activity that is
     * not tied to a transaction (transaction_id nullable) and is grouped by a
     * `category` (the sidebar module — Users, Settings, Invoice, Transactions …).
     */
    public function up(): void
    {
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->string('category')->nullable()->after('id');
            $table->index('category');
        });

        // Make transaction_id nullable (drop & re-add the FK around the change).
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->dropForeign(['transaction_id']);
        });
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->unsignedBigInteger('transaction_id')->nullable()->change();
        });
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->foreign('transaction_id')->references('id')->on('transactions')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->dropForeign(['transaction_id']);
        });
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->dropIndex(['category']);
            $table->dropColumn('category');
        });
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->foreign('transaction_id')->references('id')->on('transactions')->cascadeOnDelete();
        });
    }
};
