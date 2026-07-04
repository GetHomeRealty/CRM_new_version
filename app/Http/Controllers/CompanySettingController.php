<?php

namespace App\Http\Controllers;

use App\Models\CompanySetting;
use App\Services\AuditService;
use Illuminate\Http\Request;

class CompanySettingController extends Controller
{
    public function __construct(private AuditService $audit)
    {
    }

    public function show()
    {
        return response()->json(CompanySetting::current());
    }

    public function update(Request $request)
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'address' => ['nullable', 'string', 'max:255'],
            'phone' => ['nullable', 'string', 'max:50'],
            'email' => ['nullable', 'string', 'max:255'],
            'hst_number' => ['nullable', 'string', 'max:100'],
            'bank_beneficiary' => ['nullable', 'string', 'max:255'],
            'bank_name' => ['nullable', 'string', 'max:100'],
            'transit_no' => ['nullable', 'string', 'max:50'],
            'account_no' => ['nullable', 'string', 'max:50'],
            'institution_no' => ['nullable', 'string', 'max:50'],
            'currency' => ['nullable', 'string', 'max:8'],
            'default_tax_rate' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'invoice_prefix' => ['nullable', 'string', 'max:20'],
            'next_invoice_no' => ['nullable', 'integer', 'min:1'],
            'default_terms' => ['nullable', 'string', 'max:50'],
            'thank_you_note' => ['nullable', 'string'],
            'deposit_heading' => ['nullable', 'string'],
        ]);

        $settings = CompanySetting::current();
        $settings->update($data);

        $this->audit->logModule('Settings', [
            'section' => 'Company Settings', 'field' => 'Company Settings', 'action' => 'Settings updated',
            'details' => $data['name'] ?? null,
        ]);

        return response()->json($settings);
    }
}
