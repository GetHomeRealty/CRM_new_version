<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('team_members', function (Blueprint $table) {
            $table->id();
            $table->foreignId('transaction_id')->constrained()->cascadeOnDelete();
            $table->string('name');
            $table->decimal('split', 8, 4)->default(0);      // % of the deal commission
            $table->decimal('agent_pct', 8, 4)->default(90); // agent's share of their split
            $table->decimal('brok_pct', 8, 4)->default(10);  // brokerage's share of their split
            $table->boolean('is_primary')->default(false);   // primary agent (from Basic Info)
            $table->string('scope')->default('Entire');      // Entire | Particular (precon term scoping)
            $table->unsignedInteger('position')->default(0);
            $table->timestamps();
        });

        // Precon term scoping for "Particular" team members (normalized).
        Schema::create('team_member_terms', function (Blueprint $table) {
            $table->id();
            $table->foreignId('team_member_id')->constrained()->cascadeOnDelete();
            $table->unsignedInteger('term_no');
            $table->timestamps();

            $table->unique(['team_member_id', 'term_no']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('team_member_terms');
        Schema::dropIfExists('team_members');
    }
};
