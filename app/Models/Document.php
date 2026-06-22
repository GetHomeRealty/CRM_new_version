<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Document extends Model
{
    protected $fillable = [
        'transaction_id', 'title', 'mandatory', 'is_condition',
        'status', 'validation', 'remarks', 'file_name', 'file_path', 'position',
    ];

    protected function casts(): array
    {
        return ['mandatory' => 'boolean', 'is_condition' => 'boolean'];
    }

    public function transaction(): BelongsTo
    {
        return $this->belongsTo(Transaction::class);
    }
}
