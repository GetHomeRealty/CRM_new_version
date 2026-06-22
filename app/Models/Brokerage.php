<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Brokerage extends Model
{
    protected $fillable = ['transaction_id', 'name', 'address', 'email', 'invoice_email', 'agent_email', 'phone'];

    public function transaction(): BelongsTo
    {
        return $this->belongsTo(Transaction::class);
    }

    public function agents(): HasMany
    {
        return $this->hasMany(BrokerageAgent::class)->orderBy('position');
    }
}
