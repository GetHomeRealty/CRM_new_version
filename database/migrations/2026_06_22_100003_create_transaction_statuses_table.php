<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Status is multi-select in the UI, so it's a normalized set per transaction.
        Schema::create('transaction_statuses', function (Blueprint $table) {
            $table->id();
            $table->foreignId('transaction_id')->constrained()->cascadeOnDelete();
            $table->string('status');
            $table->timestamps();

            $table->unique(['transaction_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('transaction_statuses');
    }
};
