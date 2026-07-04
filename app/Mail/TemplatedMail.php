<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

/**
 * A fully-rendered email: subject + HTML body + explicit from address. Used by
 * TemplateMailService after a template has been resolved and its variables rendered.
 */
class TemplatedMail extends Mailable
{
    use Queueable, SerializesModels;

    public function __construct(
        public string $subjectLine,
        public string $htmlBody,
        public string $fromEmail,
        public ?string $fromName = null,
        // Note: not "replyTo" — that name collides with the base Mailable property.
        public ?string $replyToAddress = null,
    ) {
    }

    public function envelope(): Envelope
    {
        return new Envelope(
            from: new Address($this->fromEmail, $this->fromName ?: null),
            subject: $this->subjectLine,
            replyTo: $this->replyToAddress ? [new Address($this->replyToAddress)] : [],
        );
    }

    public function content(): Content
    {
        return new Content(htmlString: $this->htmlBody);
    }
}
