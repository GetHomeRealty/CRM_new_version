<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class InterBoardListing extends Model
{
    protected $fillable = ['transaction_id', 'name', 'board_id', 'verified', 'position'];

    protected function casts(): array
    {
        return ['verified' => 'boolean'];
    }

    public function transaction(): BelongsTo
    {
        return $this->belongsTo(Transaction::class);
    }
}
