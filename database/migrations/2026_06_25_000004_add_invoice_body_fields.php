<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Invoice document body fields (customer contact, discount, notes, terms,
 * signature) so the invoice view matches the brokerage's layout. All additive
 * and nullable/defaulted — existing invoices are unaffected.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('invoices', function (Blueprint $table) {
            $table->string('customer_phone')->nullable()->after('customer_name');
            $table->string('customer_email')->nullable()->after('customer_phone');
            $table->decimal('discount', 12, 2)->default(0)->after('total');
            $table->text('customer_notes')->nullable()->after('discount');
            $table->text('terms_conditions')->nullable()->after('customer_notes');
            $table->string('signature_path')->nullable()->after('terms_conditions');
        });
    }

    public function down(): void
    {
        Schema::table('invoices', function (Blueprint $table) {
            $table->dropColumn(['customer_phone', 'customer_email', 'discount', 'customer_notes', 'terms_conditions', 'signature_path']);
        });
    }
};
