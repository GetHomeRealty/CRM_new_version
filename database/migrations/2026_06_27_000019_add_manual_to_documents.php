<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Marks documents added by hand via the "+ Add" field in Legal & Documentation
     * (as opposed to the seeded checklist, status-driven, RECO Guide or condition
     * docs). Only these show the agent "Accept this document?" option.
     */
    public function up(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->boolean('manual')->default(false)->after('is_condition');
        });
    }

    public function down(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->dropColumn('manual');
        });
    }
};
