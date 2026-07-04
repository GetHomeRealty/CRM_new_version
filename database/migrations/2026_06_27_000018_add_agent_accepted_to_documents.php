<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Agent's answer on whether a document (typically one an admin added) is accepted
     * for this transaction. null = not answered yet, 'Accepted' = uploads enabled,
     * 'Not Accepted' = uploads disabled and reminders suppressed for that document.
     */
    public function up(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->string('agent_accepted')->nullable()->after('reminder');
        });
    }

    public function down(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->dropColumn('agent_accepted');
        });
    }
};
