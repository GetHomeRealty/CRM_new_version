<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            // Whether the document has been backed up to the shared Drive. 'Yes'/'No'/null.
            $table->string('drive_uploaded')->nullable()->after('validation');
        });
    }

    public function down(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->dropColumn('drive_uploaded');
        });
    }
};
