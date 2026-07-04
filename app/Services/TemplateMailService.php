<?php

namespace App\Services;

use App\Mail\MailEventRegistry;
use App\Mail\TemplatedMail;
use App\Models\EmailTemplate;
use App\Models\MailAccount;
use Illuminate\Support\Facades\Mail;

/**
 * Resolves the template + sender for an email event, renders the variables, and
 * dispatches the message via that account's SMTP settings — all server-side.
 */
class TemplateMailService
{
    /**
     * Send the email registered under $eventKey to $to, with $vars substituted into
     * the template's subject and body.
     *
     * @param  string|array<int, string>  $to
     * @param  array<int, string>  $cc
     */
    public function send(string $eventKey, array $vars, string|array $to, array $cc = [], ?string $replyTo = null): void
    {
        $template = $this->resolveTemplate($eventKey);
        if (! $template || ! $template->is_active) {
            throw new \RuntimeException("No active email template for event '{$eventKey}'.");
        }

        // Sender = the template's chosen account, else the default active account.
        $account = $template->mailAccount && $template->mailAccount->is_active
            ? $template->mailAccount
            : MailAccount::where('is_active', true)->where('is_default', true)->first();

        if (! $account) {
            throw new \RuntimeException("No SMTP sender is configured for '{$eventKey}' (no template account and no default active account).");
        }

        $vars = array_merge($this->globalVars(), $vars);
        $subject = TemplateRenderer::render($template->subject, $vars);
        $body = TemplateRenderer::render($template->body_html, $vars);

        $this->dispatchViaAccount($account, $to, $subject, $body, $cc, $replyTo);
    }

    /** Send a fixed test message through a specific account (SMTP smoke test). */
    public function test(MailAccount $account, string $to): void
    {
        $subject = 'Test email — '.($account->from_name ?: $account->name);
        $body = '<p>This is a test message confirming the SMTP account <strong>'.e($account->name).'</strong> is configured correctly.</p>'
            .'<p>Host: '.e($account->host).':'.(int) $account->port.'<br>Sent: '.now()->toDayDateTimeString().'</p>';

        $this->dispatchViaAccount($account, $to, $subject, $body);
    }

    /** App-wide variables merged into every send. */
    protected function globalVars(): array
    {
        return [
            'current_date' => now()->toFormattedDateString(),
            'current_year' => (string) now()->year,
        ];
    }

    /** Load the template row, seeding it from the registry defaults if missing. */
    protected function resolveTemplate(string $eventKey): ?EmailTemplate
    {
        if (MailEventRegistry::exists($eventKey)) {
            $meta = MailEventRegistry::all()[$eventKey];

            return EmailTemplate::firstOrCreate(
                ['event_key' => $eventKey],
                [
                    'module' => $meta['module'],
                    'name' => $meta['label'],
                    'subject' => $meta['default_subject'],
                    'body_html' => $meta['default_body_html'],
                    'is_active' => true,
                ],
            );
        }

        return EmailTemplate::where('event_key', $eventKey)->first();
    }

    /**
     * Build a one-off SMTP mailer from the account at runtime and send. The account
     * password is auto-decrypted by the model cast.
     *
     * @param  string|array<int, string>  $to
     * @param  array<int, string>  $cc
     */
    protected function dispatchViaAccount(MailAccount $account, string|array $to, string $subject, string $html, array $cc = [], ?string $replyTo = null): void
    {
        config(['mail.mailers.tx_dynamic' => [
            'transport' => 'smtp',
            'host' => $account->host,
            'port' => (int) $account->port,
            'encryption' => $account->encryption ?: null,
            'username' => $account->username,
            'password' => $account->password,
            'timeout' => 30,
        ]]);

        // Drop any previously-built instance so the fresh config is used.
        app('mail.manager')->forgetMailers();

        // Never CC an address that's already a primary recipient.
        $toList = array_map('strtolower', (array) $to);
        $cc = array_values(array_filter(array_unique($cc), fn ($e) => $e && ! in_array(strtolower($e), $toList, true)));

        $pending = Mail::mailer('tx_dynamic')->to($to);
        if ($cc) {
            $pending->cc($cc);
        }
        $pending->send(new TemplatedMail(
            subjectLine: $subject,
            htmlBody: $html,
            fromEmail: $account->from_email,
            fromName: $account->from_name,
            replyToAddress: $replyTo,
        ));
    }
}
