<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreMailAccountRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // route is admin-gated
    }

    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'from_name' => ['nullable', 'string', 'max:255'],
            'from_email' => ['required', 'email', 'max:255'],
            'host' => ['required', 'string', 'max:255'],
            'port' => ['nullable', 'integer', 'min:1', 'max:65535'],
            'username' => ['nullable', 'string', 'max:255'],
            'password' => ['nullable', 'string', 'max:1000'],
            'encryption' => ['nullable', Rule::in(['tls', 'ssl'])],
            'is_active' => ['nullable', 'boolean'],
            'is_default' => ['nullable', 'boolean'],
        ];
    }
}
