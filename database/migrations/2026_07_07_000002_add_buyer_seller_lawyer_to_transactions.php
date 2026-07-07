<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            // Sale/Buy deals capture both sides' lawyers (the legacy lawyer_* fields
            // stay as the primary side that feeds Notice of Sale / Trade Sheet).
            $table->string('buyer_lawyer_name')->nullable()->after('lawyer_address');
            $table->string('buyer_lawyer_email')->nullable()->after('buyer_lawyer_name');
            $table->string('buyer_lawyer_phone')->nullable()->after('buyer_lawyer_email');
            $table->string('buyer_lawyer_address')->nullable()->after('buyer_lawyer_phone');
            $table->string('seller_lawyer_name')->nullable()->after('buyer_lawyer_address');
            $table->string('seller_lawyer_email')->nullable()->after('seller_lawyer_name');
            $table->string('seller_lawyer_phone')->nullable()->after('seller_lawyer_email');
            $table->string('seller_lawyer_address')->nullable()->after('seller_lawyer_phone');
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn([
                'buyer_lawyer_name', 'buyer_lawyer_email', 'buyer_lawyer_phone', 'buyer_lawyer_address',
                'seller_lawyer_name', 'seller_lawyer_email', 'seller_lawyer_phone', 'seller_lawyer_address',
            ]);
        });
    }
};
