<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * §5.1 — when a transaction is DFT or Closed, an Admin (manager) cannot edit
 * directly; they raise an edit request that a Super Admin must approve before
 * the edit can be applied.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('transaction_edit_requests', function (Blueprint $table) {
            $table->id();
            $table->foreignId('transaction_id')->constrained()->cascadeOnDelete();
            $table->string('status_at_request')->nullable(); // DFT / Closed
            $table->unsignedBigInteger('requested_by')->nullable();
            $table->string('requested_by_name')->nullable();
            $table->text('reason')->nullable();
            $table->string('status')->default('pending'); // pending | approved | rejected | applied
            $table->unsignedBigInteger('reviewed_by')->nullable();
            $table->string('reviewed_by_name')->nullable();
            $table->timestamp('reviewed_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('transaction_edit_requests');
    }
};
