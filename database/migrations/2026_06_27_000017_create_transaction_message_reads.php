<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Per-user "last read" marker for a transaction's chat thread. Unread count =
     * messages created after last_read_at that the user didn't send themselves.
     */
    public function up(): void
    {
        Schema::create('transaction_message_reads', function (Blueprint $table) {
            $table->id();
            $table->foreignId('transaction_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->timestamp('last_read_at')->nullable();
            $table->timestamps();
            $table->unique(['transaction_id', 'user_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('transaction_message_reads');
    }
};
