<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Condition extends Model
{
    protected $fillable = ['transaction_id', 'type', 'custom_name', 'deadline', 'status', 'position'];

    protected function casts(): array
    {
        return ['deadline' => 'date'];
    }

    public function transaction(): BelongsTo
    {
        return $this->belongsTo(Transaction::class);
    }
}
