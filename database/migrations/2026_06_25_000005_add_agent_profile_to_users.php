<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Agent onboarding profile. `username` and `status` are first-class (status gates
 * login); the remaining onboarding fields (mobile, gender, commission, loan,
 * etc.) live in a flexible `profile` JSON. All additive/nullable — existing
 * users (and login by email) keep working.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->string('username')->nullable()->unique()->after('name');
            $table->string('status')->default('Active')->after('role');
            $table->json('profile')->nullable()->after('status');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropUnique(['username']);
            $table->dropColumn(['username', 'status', 'profile']);
        });
    }
};
