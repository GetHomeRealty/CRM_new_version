<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class AuditLog extends Model
{
    protected $fillable = ['transaction_id', 'category', 'who', 'user_id', 'section', 'field', 'old_value', 'new_value', 'action', 'source', 'details', 'handled'];

    protected function casts(): array
    {
        return ['handled' => 'boolean'];
    }

    public function transaction(): BelongsTo
    {
        return $this->belongsTo(Transaction::class);
    }
}
