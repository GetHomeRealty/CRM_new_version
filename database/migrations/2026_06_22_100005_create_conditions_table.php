<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('conditions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('transaction_id')->constrained()->cascadeOnDelete();
            $table->string('type')->default('Financing'); // Financing, Home Inspection, ... or Custom
            $table->string('custom_name')->nullable();
            $table->date('deadline')->nullable();
            $table->string('status')->default('Pending'); // Pending | Waived | Fulfilled | Not Met
            $table->unsignedInteger('position')->default(0);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('conditions');
    }
};
