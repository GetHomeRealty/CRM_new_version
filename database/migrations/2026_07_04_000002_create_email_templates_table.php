<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * One editable template per email event (subject + HTML body). mail_account_id
     * is the sender decision; when null, sending falls back to the default account.
     */
    public function up(): void
    {
        Schema::create('email_templates', function (Blueprint $table) {
            $table->id();
            $table->string('event_key')->unique();
            $table->string('module');
            $table->string('name');
            $table->string('subject');
            $table->longText('body_html');
            $table->foreignId('mail_account_id')->nullable()->constrained()->nullOnDelete();
            $table->boolean('is_active')->default(true);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('email_templates');
    }
};
