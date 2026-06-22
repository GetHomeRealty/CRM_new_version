<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // One row per preconstruction commission term (% + closing date).
        // Money amounts are computed by CommissionService, not stored.
        Schema::create('precon_terms', function (Blueprint $table) {
            $table->id();
            $table->foreignId('transaction_id')->constrained()->cascadeOnDelete();
            $table->unsignedInteger('term_no');
            $table->decimal('pct', 8, 4)->nullable();
            $table->date('closing_date')->nullable();
            $table->timestamps();

            $table->unique(['transaction_id', 'term_no']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('precon_terms');
    }
};
