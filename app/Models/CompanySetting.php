<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class CompanySetting extends Model
{
    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['default_tax_rate' => 'decimal:2', 'next_invoice_no' => 'integer'];
    }

    public static function current(): self
    {
        return static::query()->firstOrCreate(['id' => 1]);
    }
}
