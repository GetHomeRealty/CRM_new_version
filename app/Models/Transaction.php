<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

class Transaction extends Model
{
    /** The 12 transaction types supported by the Add modal. */
    public const TYPES = [
        'Residential Buying',
        'Residential Lease',
        'Residential Sale Listing',
        'Residential Lease Listing',
        'Preconstruction',
        'Referral',
        'Commercial Property Buying',
        'Commercial Property Lease',
        'Commercial Property Sale Listing',
        'Commercial Property Lease Listing',
        'Business Buying',
        'Business Sale',
    ];

    public const LISTING_TYPES = [
        'Residential Sale Listing',
        'Residential Lease Listing',
        'Commercial Property Sale Listing',
        'Commercial Property Lease Listing',
    ];

    public static function isListingType(?string $type): bool
    {
        return in_array($type, self::LISTING_TYPES, true);
    }

    protected $fillable = [
        'trade_no', 'type', 'property', 'agent', 'price', 'deposit',
        'offer_date', 'closing_date', 'listing_contract_date', 'listing_expiry_date',
        'mls_type', 'mls_num', 'mls_verified',
        'comm_type', 'comm_value', 'comm_pct', 'comm_amt',
        'comm_status', 'comm_paid_status', 'valid_status',
        'conditional_offer', 'inter_board_enabled',
    ];

    protected function casts(): array
    {
        return [
            'price' => 'decimal:2',
            'deposit' => 'decimal:2',
            'comm_value' => 'decimal:2',
            'comm_pct' => 'decimal:4',
            'comm_amt' => 'decimal:2',
            'offer_date' => 'date',
            'closing_date' => 'date',
            'listing_contract_date' => 'date',
            'listing_expiry_date' => 'date',
            'mls_verified' => 'boolean',
            'conditional_offer' => 'boolean',
            'inter_board_enabled' => 'boolean',
        ];
    }

    public function statuses(): HasMany
    {
        return $this->hasMany(TransactionStatus::class);
    }

    public function clients(): HasMany
    {
        return $this->hasMany(Client::class)->orderBy('position');
    }

    public function conditions(): HasMany
    {
        return $this->hasMany(Condition::class)->orderBy('position');
    }

    public function interBoardListings(): HasMany
    {
        return $this->hasMany(InterBoardListing::class)->orderBy('position');
    }

    public function brokerage(): HasOne
    {
        return $this->hasOne(Brokerage::class);
    }

    public function auditLogs(): HasMany
    {
        return $this->hasMany(AuditLog::class)->latest();
    }

    /** Status values as a flat array (UI works with a list). */
    public function statusList(): array
    {
        $list = $this->statuses->pluck('status')->all();

        return $list ?: ['Open'];
    }
}
