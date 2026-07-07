<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * FINTRAC identity record extracted from a client's uploaded photo ID and shown
     * (editable, review-before-save) in Form 630. One row per (transaction, client).
     * The identity fields are encrypted at rest (model cast) — sensitive PII.
     */
    public function up(): void
    {
        Schema::create('client_identifications', function (Blueprint $table) {
            $table->id();
            $table->foreignId('transaction_id')->constrained()->cascadeOnDelete();
            $table->string('client_name');
            // Encrypted values are stored as ciphertext — use text columns.
            $table->text('full_legal_name')->nullable();
            $table->text('address')->nullable();
            $table->text('dob')->nullable();
            $table->text('occupation')->nullable();
            $table->text('id_type')->nullable();
            $table->text('id_number')->nullable();
            $table->text('issuing_jurisdiction')->nullable();
            $table->text('country')->nullable();
            $table->text('expiry_date')->nullable();
            $table->string('source')->default('extracted'); // extracted | manual
            $table->boolean('verified')->default(false);
            $table->timestamp('extracted_at')->nullable();
            $table->timestamps();
            $table->unique(['transaction_id', 'client_name']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('client_identifications');
    }
};
