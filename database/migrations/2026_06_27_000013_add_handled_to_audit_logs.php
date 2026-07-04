<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Agent-made changes are reviewed individually: an admin either accepts them
     * (Mark reviewed) or rejects a single change (reverting the field). `handled`
     * marks an agent audit entry as dealt with so it leaves the review banner.
     */
    public function up(): void
    {
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->boolean('handled')->default(false)->after('source');
        });
    }

    public function down(): void
    {
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->dropColumn('handled');
        });
    }
};
