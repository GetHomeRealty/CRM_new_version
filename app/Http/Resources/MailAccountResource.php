<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** Never exposes the password; reports whether one is stored via has_password. */
class MailAccountResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'from_name' => $this->from_name,
            'from_email' => $this->from_email,
            'host' => $this->host,
            'port' => (int) $this->port,
            'username' => $this->username,
            'encryption' => $this->encryption,
            'is_active' => (bool) $this->is_active,
            'is_default' => (bool) $this->is_default,
            // Checked against the raw column so we never decrypt just to test presence.
            'has_password' => filled($this->getRawOriginal('password')),
            'created_at' => $this->created_at?->toDateTimeString(),
        ];
    }
}
