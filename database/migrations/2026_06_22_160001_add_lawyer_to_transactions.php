<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->string('lawyer_name')->nullable()->after('builder_phone');
            $table->string('lawyer_email')->nullable()->after('lawyer_name');
            $table->string('lawyer_phone')->nullable()->after('lawyer_email');
            $table->string('lawyer_address')->nullable()->after('lawyer_phone');
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn(['lawyer_name', 'lawyer_email', 'lawyer_phone', 'lawyer_address']);
        });
    }
};
