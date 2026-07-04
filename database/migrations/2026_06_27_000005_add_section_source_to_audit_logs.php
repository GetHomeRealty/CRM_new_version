<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Comprehensive audit trail: record which section/category a change belongs to and
 * the source of the action (Manual, System, Quick Action). `field`, `old_value`,
 * `new_value`, `action`, `who`, `user_id` already exist.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->string('section')->nullable()->after('user_id');
            $table->string('source')->nullable()->after('action');
        });
    }

    public function down(): void
    {
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->dropColumn(['section', 'source']);
        });
    }
};
