<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class MailAccount extends Model
{
    protected $fillable = [
        'name', 'from_name', 'from_email', 'host', 'port',
        'username', 'password', 'encryption', 'is_active', 'is_default',
    ];

    protected function casts(): array
    {
        return [
            'password' => 'encrypted', // encrypted at rest, auto-decrypted on read
            'port' => 'integer',
            'is_active' => 'boolean',
            'is_default' => 'boolean',
        ];
    }

    public function templates(): HasMany
    {
        return $this->hasMany(EmailTemplate::class);
    }
}
