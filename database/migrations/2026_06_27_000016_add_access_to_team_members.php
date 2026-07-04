<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Access level for a team member's agent portal:
     *  - 'full' : selected at transaction creation (Team option) → same edit rights
     *             as the primary agent (basic info, lawyer, team split, docs).
     *  - 'docs' : added later via Team Split → upload/replace docs only; the rest is
     *             view-only.
     * Existing rows default to 'docs' to preserve the current split-member behaviour.
     */
    public function up(): void
    {
        Schema::table('team_members', function (Blueprint $table) {
            $table->string('access')->default('docs')->after('is_primary');
        });
    }

    public function down(): void
    {
        Schema::table('team_members', function (Blueprint $table) {
            $table->dropColumn('access');
        });
    }
};
