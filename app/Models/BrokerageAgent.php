<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class BrokerageAgent extends Model
{
    protected $fillable = ['brokerage_id', 'name', 'position'];

    public function brokerage(): BelongsTo
    {
        return $this->belongsTo(Brokerage::class);
    }
}
