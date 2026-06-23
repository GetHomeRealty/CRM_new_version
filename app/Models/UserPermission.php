<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class UserPermission extends Model
{
    protected $fillable = ['user_id', 'screen', 'level'];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
