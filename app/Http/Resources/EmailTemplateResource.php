<?php

namespace App\Http\Resources;

use App\Mail\MailEventRegistry;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class EmailTemplateResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'event_key' => $this->event_key,
            'module' => $this->module,
            'name' => $this->name,
            'subject' => $this->subject,
            'body_html' => $this->body_html,
            'mail_account_id' => $this->mail_account_id,
            'is_active' => (bool) $this->is_active,
            'variables' => MailEventRegistry::variablesFor($this->event_key),
            'mail_account' => $this->whenLoaded('mailAccount', fn () => $this->mailAccount ? [
                'id' => $this->mailAccount->id,
                'name' => $this->mailAccount->name,
                'from_email' => $this->mailAccount->from_email,
            ] : null),
            'updated_at' => $this->updated_at?->toDateTimeString(),
        ];
    }
}
