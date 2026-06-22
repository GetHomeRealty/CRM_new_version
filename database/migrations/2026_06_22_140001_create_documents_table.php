<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('documents', function (Blueprint $table) {
            $table->id();
            $table->foreignId('transaction_id')->constrained()->cascadeOnDelete();
            $table->string('title');
            $table->boolean('mandatory')->default(false);
            $table->boolean('is_condition')->default(false);
            $table->string('status')->default('Pending');      // Pending | Received
            $table->string('validation')->default('Pending');  // Pending | Valid | Invalid
            $table->text('remarks')->nullable();               // reason when Invalid
            $table->string('file_name')->nullable();           // original uploaded filename
            $table->string('file_path')->nullable();           // storage path
            $table->unsignedInteger('position')->default(0);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('documents');
    }
};
