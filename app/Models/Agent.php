<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Agent extends Model
{
    protected $fillable = ['name', 'is_team', 'active'];

    protected function casts(): array
    {
        return ['is_team' => 'boolean', 'active' => 'boolean'];
    }
}
