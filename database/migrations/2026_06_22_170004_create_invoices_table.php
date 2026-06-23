<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('invoices', function (Blueprint $table) {
            $table->id();
            $table->string('invoice_no')->unique();
            $table->foreignId('transaction_id')->nullable()->constrained()->nullOnDelete();

            $table->string('property_reference')->nullable();

            // Customer (snapshot on the invoice; optional link to master)
            $table->foreignId('customer_id')->nullable()->constrained()->nullOnDelete();
            $table->string('customer_name')->nullable();
            $table->string('customer_address')->nullable();
            $table->string('customer_city')->nullable();
            $table->string('customer_province')->nullable();
            $table->string('customer_postal_code')->nullable();
            $table->string('customer_country')->default('Canada');

            // Meta
            $table->date('invoice_date');
            $table->string('terms')->default('Due on Receipt');
            $table->date('due_date')->nullable();
            $table->string('trade_number')->nullable();
            $table->string('listing_agent')->nullable();
            $table->string('coop_salesperson')->nullable();
            $table->text('subject')->nullable();

            // Status + money
            $table->string('status')->default('Draft'); // Draft|Unpaid|Partially Paid|Paid|Void
            $table->decimal('sub_total', 15, 2)->default(0);
            $table->decimal('tax_total', 15, 2)->default(0);
            $table->decimal('total', 15, 2)->default(0);
            $table->decimal('amount_paid', 15, 2)->default(0);
            $table->decimal('balance_due', 15, 2)->default(0);

            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('invoices');
    }
};
