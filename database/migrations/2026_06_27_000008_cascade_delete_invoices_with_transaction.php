<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * When a transaction is deleted, its invoices must be deleted too (previously
     * the FK only nulled invoices.transaction_id, leaving orphaned invoices).
     * Invoice line items and payments already cascade from their invoice.
     */
    public function up(): void
    {
        Schema::table('invoices', function (Blueprint $table) {
            $table->dropForeign(['transaction_id']);
            $table->foreign('transaction_id')->references('id')->on('transactions')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('invoices', function (Blueprint $table) {
            $table->dropForeign(['transaction_id']);
            $table->foreign('transaction_id')->references('id')->on('transactions')->nullOnDelete();
        });
    }
};
