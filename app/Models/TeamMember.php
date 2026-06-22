<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class TeamMember extends Model
{
    protected $fillable = ['transaction_id', 'name', 'split', 'agent_pct', 'brok_pct', 'is_primary', 'scope', 'position'];

    protected function casts(): array
    {
        return [
            'split' => 'decimal:4',
            'agent_pct' => 'decimal:4',
            'brok_pct' => 'decimal:4',
            'is_primary' => 'boolean',
        ];
    }

    public function transaction(): BelongsTo
    {
        return $this->belongsTo(Transaction::class);
    }

    public function terms(): HasMany
    {
        return $this->hasMany(TeamMemberTerm::class);
    }
}
