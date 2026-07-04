<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class TransactionEditRequest extends Model
{
    protected $fillable = [
        'transaction_id', 'status_at_request', 'requested_by', 'requested_by_name',
        'reason', 'status', 'reviewed_by', 'reviewed_by_name', 'reviewed_at',
    ];

    protected function casts(): array
    {
        return ['reviewed_at' => 'datetime'];
    }

    public function transaction(): BelongsTo
    {
        return $this->belongsTo(Transaction::class);
    }
}
