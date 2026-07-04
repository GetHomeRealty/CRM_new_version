<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class EmailTemplate extends Model
{
    protected $fillable = [
        'event_key', 'module', 'name', 'subject', 'body_html', 'mail_account_id', 'is_active',
    ];

    protected function casts(): array
    {
        return ['is_active' => 'boolean'];
    }

    public function mailAccount(): BelongsTo
    {
        return $this->belongsTo(MailAccount::class);
    }
}
