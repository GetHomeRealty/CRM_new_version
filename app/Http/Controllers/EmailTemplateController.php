<?php

namespace App\Http\Controllers;

use App\Http\Requests\UpdateEmailTemplateRequest;
use App\Http\Resources\EmailTemplateResource;
use App\Http\Resources\MailAccountResource;
use App\Mail\MailEventRegistry;
use App\Models\CompanySetting;
use App\Models\EmailTemplate;
use App\Models\MailAccount;
use App\Services\TemplateRenderer;

class EmailTemplateController extends Controller
{
    /**
     * Ensure every registry event has an editable template row, then return the
     * templates grouped by module along with the available sender accounts.
     */
    public function index()
    {
        foreach (MailEventRegistry::all() as $key => $meta) {
            EmailTemplate::firstOrCreate(
                ['event_key' => $key],
                [
                    'module' => $meta['module'],
                    'name' => $meta['label'],
                    'subject' => $meta['default_subject'],
                    'body_html' => $meta['default_body_html'],
                    'is_active' => true,
                ],
            );
        }

        $templates = EmailTemplate::with('mailAccount')->orderBy('module')->orderBy('name')->get();

        $groups = [];
        foreach ($templates as $t) {
            $groups[$t->module][] = (new EmailTemplateResource($t))->resolve();
        }

        return response()->json([
            'groups' => collect($groups)->map(fn ($items, $module) => [
                'module' => $module,
                'templates' => $items,
            ])->values(),
            'mail_accounts' => MailAccountResource::collection(
                MailAccount::orderByDesc('is_default')->orderBy('name')->get()
            ),
        ]);
    }

    public function update(UpdateEmailTemplateRequest $request, EmailTemplate $emailTemplate)
    {
        $emailTemplate->update($request->validated());

        return new EmailTemplateResource($emailTemplate->fresh('mailAccount'));
    }

    /** Render the template with sample values so the editor can preview output. */
    public function preview(EmailTemplate $emailTemplate)
    {
        $vars = $this->sampleVars($emailTemplate->event_key);

        return response()->json([
            'subject' => TemplateRenderer::render($emailTemplate->subject, $vars),
            'html' => TemplateRenderer::render($emailTemplate->body_html, $vars),
        ]);
    }

    /** The full event catalog (module, label, variables, defaults). */
    public function events()
    {
        return response()->json(MailEventRegistry::all());
    }

    /** Realistic sample values for each known variable (used by preview). */
    private function sampleVars(string $eventKey): array
    {
        $company = CompanySetting::current()->name;
        $samples = [
            'invoice_number' => 'INV-1042',
            'invoice_total' => '$5,250.00',
            'due_date' => now()->addDays(14)->toFormattedDateString(),
            'customer_name' => 'John Smith',
            'transaction_number' => 'GHR-002',
            'property_address' => '83 Parity Road, Brampton, ON, L6X 5N1',
            'sale_price' => '$750,000.00',
            'closing_date' => now()->addDays(45)->toFormattedDateString(),
            'agent_name' => 'Jane Agent',
            'pending_docs' => 'FINTRAC, Client Photo IDs, Deposit Receipt',
            'deposit_amount' => '$25,000.00',
            'company_name' => $company,
            'current_date' => now()->toFormattedDateString(),
            'current_year' => (string) now()->year,
        ];

        // Restrict to this event's declared variables (+ globals), with a fallback.
        $vars = [];
        foreach (array_merge(MailEventRegistry::variablesFor($eventKey), ['current_date', 'current_year']) as $v) {
            $vars[$v] = $samples[$v] ?? ('{'.$v.'}');
        }

        return $vars;
    }
}
