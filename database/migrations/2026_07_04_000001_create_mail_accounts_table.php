<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * SMTP "sender" accounts. Passwords are stored encrypted (model cast). Only one
     * row may be is_default = true at a time (enforced in the controller).
     */
    public function up(): void
    {
        Schema::create('mail_accounts', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('from_name')->nullable();
            $table->string('from_email');
            $table->string('host');
            $table->integer('port')->default(587);
            $table->string('username')->nullable();
            $table->text('password')->nullable(); // encrypted at rest
            $table->string('encryption')->nullable(); // tls | ssl | null
            $table->boolean('is_active')->default(true);
            $table->boolean('is_default')->default(false);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('mail_accounts');
    }
};
