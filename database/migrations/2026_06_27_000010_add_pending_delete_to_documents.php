<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * When an agent deletes a document it is not removed — it is flagged for
     * deletion (pending_delete) and surfaced to admins, who finally delete or
     * restore it.
     */
    public function up(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->boolean('pending_delete')->default(false)->after('status');
            $table->string('deleted_by')->nullable()->after('pending_delete');
        });
    }

    public function down(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->dropColumn(['pending_delete', 'deleted_by']);
        });
    }
};
