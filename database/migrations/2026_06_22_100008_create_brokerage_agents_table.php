<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // The brokerage's agent name list (1..n) — normalized out of the brokerage block.
        Schema::create('brokerage_agents', function (Blueprint $table) {
            $table->id();
            $table->foreignId('brokerage_id')->constrained()->cascadeOnDelete();
            $table->string('name');
            $table->unsignedInteger('position')->default(0);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('brokerage_agents');
    }
};
