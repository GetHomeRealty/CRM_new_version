<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * §13 special document rows:
 *  - `files` JSON holds multiple uploads (Deposit Receipt = many; Photo IDs /
 *    FINTRAC = one per client, tagged with client_name).
 *  - `condition_id` links a document row to a transaction condition so conditions
 *    appear in the checklist with their deadline.
 * The existing single-file columns (file_path/file_name) are kept for normal rows.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->json('files')->nullable()->after('file_path');
            $table->unsignedBigInteger('condition_id')->nullable()->after('is_condition');
        });
    }

    public function down(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->dropColumn(['files', 'condition_id']);
        });
    }
};
