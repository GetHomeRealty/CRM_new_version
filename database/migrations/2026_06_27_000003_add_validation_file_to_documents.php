<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * §13 — when a document is marked Invalid, staff record the reason (reuses the
 * existing `remarks` column) and may attach supporting evidence. These columns
 * hold that single validation attachment, mirroring the file_path/file_name pair.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->string('validation_file_name')->nullable()->after('files');
            $table->string('validation_file_path')->nullable()->after('validation_file_name');
        });
    }

    public function down(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->dropColumn(['validation_file_name', 'validation_file_path']);
        });
    }
};
