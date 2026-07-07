<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Document extends Model
{
    protected $fillable = [
        'transaction_id', 'title', 'mandatory', 'is_condition', 'condition_id',
        'status', 'validation', 'drive_uploaded', 'remarks', 'file_name', 'file_path', 'files',
        'validation_file_name', 'validation_file_path', 'position',
        'pending_delete', 'deleted_by', 'reminder', 'agent_accepted', 'manual',
    ];

    protected function casts(): array
    {
        return ['mandatory' => 'boolean', 'is_condition' => 'boolean', 'files' => 'array', 'pending_delete' => 'boolean', 'reminder' => 'boolean', 'manual' => 'boolean'];
    }

    public function transaction(): BelongsTo
    {
        return $this->belongsTo(Transaction::class);
    }

    public function condition(): BelongsTo
    {
        return $this->belongsTo(Condition::class);
    }

    /** §13 row kind for the checklist UI. */
    public function kind(): string
    {
        if ($this->is_condition) {
            return 'condition';
        }
        $t = strtolower($this->title);
        if (str_contains($t, 'deposit receipt') || str_contains($t, 'deposit slip')) {
            return 'multi';
        }
        if (str_contains($t, 'photo id') || str_contains($t, 'fintrac')) {
            return 'per_client';
        }

        return 'single';
    }
}
