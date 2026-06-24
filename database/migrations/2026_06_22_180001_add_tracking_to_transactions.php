<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Freeform tracking modules (mirror the original app's in-memory objects):
        // Admin Activities, Activity Tracker / Agent FAQ, Adjustment & Advance.
        Schema::table('transactions', function (Blueprint $table) {
            $table->json('admin_activities')->nullable()->after('lawyer_address');
            $table->json('activity_tracker')->nullable()->after('admin_activities');
            $table->json('adjustments')->nullable()->after('activity_tracker');
        });

        // Per-transaction chat thread.
        Schema::create('transaction_messages', function (Blueprint $table) {
            $table->id();
            $table->foreignId('transaction_id')->constrained()->cascadeOnDelete();
            $table->unsignedBigInteger('user_id')->nullable();
            $table->string('author')->nullable();
            $table->text('body');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('transaction_messages');
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn(['admin_activities', 'activity_tracker', 'adjustments']);
        });
    }
};
