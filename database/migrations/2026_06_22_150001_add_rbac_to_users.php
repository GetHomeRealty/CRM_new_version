<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->string('role')->default('agent')->after('email'); // admin | manager | agent
        });

        // Per-user screen permission overrides (over the role defaults).
        Schema::create('user_permissions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('screen');
            $table->string('level'); // none | view | edit
            $table->timestamps();

            $table->unique(['user_id', 'screen']);
        });

        // Ensure at least one admin exists: promote the earliest user.
        $first = DB::table('users')->orderBy('id')->first();
        if ($first) {
            DB::table('users')->where('id', $first->id)->update(['role' => 'admin']);
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('user_permissions');
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn('role');
        });
    }
};
