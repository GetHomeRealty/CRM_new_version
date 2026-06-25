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
        'Business Lease',
        'Business Sale',
        'Business Lease Listing',
    ];

    public const LISTING_TYPES = [
        'Residential Sale Listing',
        'Residential Lease Listing',
        'Commercial Property Sale Listing',
        'Commercial Property Lease Listing',
        'Business Lease Listing',
    ];

    /** Status family (deal-side vs listing-side). Independent of layout. Business Sale is listing-side for statuses. */
    public static function isListingStatusFamily(?string $type): bool
    {
        return self::isListingType($type) || $type === 'Business Sale';
    }

    public static function isListingType(?string $type): bool
    {
        return in_array($type, self::LISTING_TYPES, true);
    }

    /** Types that use the listing-style (Listing + Co-op) Financial layout. Business Sale opts in. */
    public static function isListingFinancialType(?string $type): bool
    {
        return self::isListingType($type) || $type === 'Business Sale';
    }

    /** Types an invoice can be generated for (co-op commission receivable). */
    public const INVOICEABLE_TYPES = [
        'Residential Buying',
        'Residential Lease',
        'Preconstruction',
        'Referral',
        'Commercial Property Buying',
        'Commercial Property Lease',
        'Business Buying',
    ];

    public static function isInvoiceableType(?string $type): bool
    {
        return in_array($type, self::INVOICEABLE_TYPES, true);
    }

    protected $fillable = [
        'trade_no', 'type', 'property', 'agent', 'price', 'deposit',
        'offer_date', 'closing_date', 'listing_contract_date', 'listing_expiry_date',
        'mls_type', 'mls_num', 'mls_verified',
        'comm_type', 'comm_value', 'comm_pct', 'comm_amt',
        'comm_adjust_enabled', 'comm_adjust_before', 'comm_adjust_after',
        'listing_comm_pct', 'coop_comm_pct',
        'listing_adj_enabled', 'listing_adj_before', 'listing_adj_after',
        'coop_adj_enabled', 'coop_adj_before', 'coop_adj_after',
        'precon_listing_type', 'precon_term_count', 'commission_agent',
        'precon_net_of_hst', 'precon_comm_pct', 'precon_comm_amt_manual', 'precon_details_of_terms',
        'builder_name', 'builder_vendor', 'builder_project', 'builder_address',
        'builder_office_email', 'builder_invoice_email', 'builder_phone',
        'lawyer_name', 'lawyer_email', 'lawyer_phone', 'lawyer_address',
        'admin_activities', 'activity_tracker', 'adjustments', 'commercial_lease',
        'comm_status', 'comm_paid_status', 'valid_status',
        'conditional_offer', 'inter_board_enabled',
    ];

    public static function isPreconType(?string $type): bool
    {
        return $type === 'Preconstruction';
    }

    /** Commercial lease types carry the extra lease calculator (structure/rent/commission). */
    public static function isCommercialLeaseType(?string $type): bool
    {
        return $type !== null
            && str_contains(strtolower($type), 'commercial')
            && str_contains(strtolower($type), 'lease');
    }

    protected function casts(): array
    {
        return [
            'price' => 'decimal:2',
            'deposit' => 'decimal:2',
            'comm_value' => 'decimal:2',
            'comm_pct' => 'decimal:4',
            'comm_amt' => 'decimal:2',
            'comm_adjust_enabled' => 'boolean',
            'comm_adjust_before' => 'decimal:2',
            'comm_adjust_after' => 'decimal:2',
            'listing_comm_pct' => 'decimal:4',
            'coop_comm_pct' => 'decimal:4',
            'listing_adj_enabled' => 'boolean',
            'listing_adj_before' => 'decimal:2',
            'listing_adj_after' => 'decimal:2',
            'coop_adj_enabled' => 'boolean',
            'coop_adj_before' => 'decimal:2',
            'coop_adj_after' => 'decimal:2',
            'precon_net_of_hst' => 'boolean',
            'precon_comm_pct' => 'decimal:4',
            'precon_comm_amt_manual' => 'decimal:2',
            'admin_activities' => 'array',
            'activity_tracker' => 'array',
            'adjustments' => 'array',
            'commercial_lease' => 'array',
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

    public function teamMembers(): HasMany
    {
        return $this->hasMany(TeamMember::class)->orderBy('position');
    }

    public function preconTerms(): HasMany
    {
        return $this->hasMany(PreconTerm::class)->orderBy('term_no');
    }

    public function documents(): HasMany
    {
        return $this->hasMany(Document::class)->orderBy('position');
    }

    public function invoices(): HasMany
    {
        return $this->hasMany(Invoice::class);
    }

    public function messages(): HasMany
    {
        return $this->hasMany(TransactionMessage::class)->orderBy('id');
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
