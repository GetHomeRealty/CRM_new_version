<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('transactions', function (Blueprint $table) {
            $table->id();
            // Human-facing trade number (e.g. "001", "200836"). Unique across the brokerage.
            $table->string('trade_no')->unique();
            $table->string('type'); // one of the 12 transaction types

            // Basic info
            $table->string('property')->nullable();      // street address
            $table->string('agent')->nullable();         // primary assigned agent (name)
            $table->decimal('price', 15, 2)->default(0);
            $table->decimal('deposit', 15, 2)->default(0);
            $table->date('offer_date')->nullable();
            $table->date('closing_date')->nullable();
            $table->date('listing_contract_date')->nullable();
            $table->date('listing_expiry_date')->nullable();

            // MLS / listing
            $table->string('mls_type')->default('mls');  // mls | exclusive
            $table->string('mls_num')->nullable();
            $table->boolean('mls_verified')->default(false);

            // Commission (backend-authoritative math reads these)
            $table->string('comm_type')->default('%');   // % | Fixed
            $table->decimal('comm_value', 15, 2)->default(0);
            $table->decimal('comm_pct', 8, 4)->nullable();
            $table->decimal('comm_amt', 15, 2)->nullable();
            $table->string('comm_status')->default('Pending');   // Pending | Received
            $table->string('comm_paid_status')->nullable();      // Yes | No | N/A
            $table->string('valid_status')->default('Pending');  // Pending | Valid | Invalid

            // Flags
            $table->boolean('conditional_offer')->default(false);
            $table->boolean('inter_board_enabled')->default(false);

            $table->timestamps();

            $table->index('type');
            $table->index('agent');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('transactions');
    }
};
