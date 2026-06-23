<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Single-row company master data (CONFIG fields printed on every invoice).
        Schema::create('company_settings', function (Blueprint $table) {
            $table->id();
            $table->string('name')->default('GetHomeRealty INC');
            $table->string('address')->nullable();
            $table->string('phone')->nullable();
            $table->string('email')->nullable();
            $table->string('logo_path')->nullable();
            $table->string('hst_number')->nullable();
            $table->string('bank_beneficiary')->nullable();
            $table->string('bank_name')->nullable();
            $table->string('transit_no')->nullable();
            $table->string('account_no')->nullable();
            $table->string('institution_no')->nullable();
            $table->string('currency', 8)->default('CAD');
            $table->decimal('default_tax_rate', 6, 2)->default(13);
            $table->string('invoice_prefix')->default('INV-');
            $table->unsignedBigInteger('next_invoice_no')->default(601107);
            $table->string('default_terms')->default('Due on Receipt');
            $table->text('thank_you_note')->nullable();
            $table->text('deposit_heading')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('company_settings');
    }
};
