<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class CompanySetting extends Model
{
    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['default_tax_rate' => 'decimal:2', 'next_invoice_no' => 'integer', 'feature_flags' => 'array'];
    }

    public static function current(): self
    {
        return static::query()->firstOrCreate(['id' => 1]);
    }

    /** Read a feature flag (Transaction Desk v2 rollout switches). */
    public static function flag(string $key, bool $default = false): bool
    {
        $flags = static::current()->feature_flags ?? [];

        return (bool) ($flags[$key] ?? $default);
    }
}
