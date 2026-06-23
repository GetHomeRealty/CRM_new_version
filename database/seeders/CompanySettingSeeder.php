<?php

namespace Database\Seeders;

use App\Models\CompanySetting;
use Illuminate\Database\Seeder;

class CompanySettingSeeder extends Seeder
{
    public function run(): void
    {
        CompanySetting::updateOrCreate(['id' => 1], [
            'name' => 'GetHomeRealty INC',
            'address' => 'UNIT-101, 218 Export Blvd, Mississauga, L5S 0A7, Ontario, Canada',
            'phone' => '905-565-9933',
            'email' => 'info@GetHomeRealty.ca & Commissionpayouts@gethomerealty.ca',
            'hst_number' => '786493262RT0001',
            'bank_beneficiary' => 'GET HOME REALTY INC',
            'bank_name' => 'TD',
            'transit_no' => '21222',
            'account_no' => '5086185',
            'institution_no' => '004',
            'currency' => 'CAD',
            'default_tax_rate' => 13,
            'invoice_prefix' => 'INV-',
            'next_invoice_no' => 601107,
            'default_terms' => 'Due on Receipt',
            'thank_you_note' => 'Thank you for the payment. You just made our day.',
            'deposit_heading' => 'NOTE:- Deposit Instructions',
        ]);
    }
}
