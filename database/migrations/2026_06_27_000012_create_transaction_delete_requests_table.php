<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Transaction deletion approval workflow: an agent requests deletion (with a
     * reason); an Admin forwards it to a Super Admin (with a reason); the Super
     * Admin approves (which deletes the transaction) or rejects.
     */
    public function up(): void
    {
        Schema::create('transaction_delete_requests', function (Blueprint $table) {
            $table->id();
            $table->foreignId('transaction_id')->constrained()->cascadeOnDelete();
            $table->unsignedBigInteger('requested_by')->nullable();
            $table->string('requested_by_name')->nullable();
            $table->text('reason')->nullable();
            $table->string('status')->default('pending'); // pending | forwarded | approved | rejected
            $table->unsignedBigInteger('forwarded_by')->nullable();
            $table->string('forwarded_by_name')->nullable();
            $table->text('forward_reason')->nullable();
            $table->unsignedBigInteger('reviewed_by')->nullable();
            $table->string('reviewed_by_name')->nullable();
            $table->timestamp('reviewed_at')->nullable();
            $table->timestamps();

            $table->index(['transaction_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('transaction_delete_requests');
    }
};
