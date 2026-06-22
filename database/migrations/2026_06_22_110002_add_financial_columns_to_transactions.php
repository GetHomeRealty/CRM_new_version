<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            // Commission adjustment (standard variant): only one of before/after is non-zero.
            $table->boolean('comm_adjust_enabled')->default(false)->after('comm_amt');
            $table->decimal('comm_adjust_before', 15, 2)->default(0)->after('comm_adjust_enabled');
            $table->decimal('comm_adjust_after', 15, 2)->default(0)->after('comm_adjust_before');
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn(['comm_adjust_enabled', 'comm_adjust_before', 'comm_adjust_after']);
        });
    }
};
