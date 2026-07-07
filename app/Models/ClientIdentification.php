<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ClientIdentification extends Model
{
    protected $fillable = [
        'transaction_id', 'client_name',
        'full_legal_name', 'address', 'dob', 'occupation',
        'id_type', 'id_number', 'issuing_jurisdiction', 'country', 'expiry_date',
        'source', 'verified', 'extracted_at',
    ];

    protected function casts(): array
    {
        return [
            // Sensitive PII — encrypted at rest.
            'full_legal_name' => 'encrypted',
            'address' => 'encrypted',
            'dob' => 'encrypted',
            'occupation' => 'encrypted',
            'id_type' => 'encrypted',
            'id_number' => 'encrypted',
            'issuing_jurisdiction' => 'encrypted',
            'country' => 'encrypted',
            'expiry_date' => 'encrypted',
            'verified' => 'boolean',
            'extracted_at' => 'datetime',
        ];
    }

    public function transaction(): BelongsTo
    {
        return $this->belongsTo(Transaction::class);
    }
}
