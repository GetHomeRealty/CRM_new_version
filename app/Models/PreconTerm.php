<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class PreconTerm extends Model
{
    protected $fillable = ['transaction_id', 'term_no', 'pct', 'closing_date'];

    protected function casts(): array
    {
        return ['pct' => 'decimal:4', 'closing_date' => 'date'];
    }

    public function transaction(): BelongsTo
    {
        return $this->belongsTo(Transaction::class);
    }
}
