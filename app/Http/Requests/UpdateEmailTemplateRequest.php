<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdateEmailTemplateRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // route is admin-gated
    }

    public function rules(): array
    {
        return [
            'subject' => ['required', 'string', 'max:998'],
            'body_html' => ['required', 'string'],
            'mail_account_id' => ['nullable', 'exists:mail_accounts,id'],
            'is_active' => ['nullable', 'boolean'],
        ];
    }
}
