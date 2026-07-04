<?php

namespace App\Services;

use App\Models\Transaction;

/**
 * Keeps the Agent FAQ Center in sync with the Legal & Documentation checklist.
 * When every document in the section is both Received and Valid, "Valid Docs
 * Cleared from Agent" auto-sets to Yes (and Final Validation to Pending unless it
 * is already Done). If any document is later not received / invalid / removed,
 * the clearance reverts to No. Runs on every document mutation.
 */
class DocsValidationService
{
    public function __construct(private AuditService $audit)
    {
    }

    public function sync(Transaction $transaction): void
    {
        $docs = $transaction->documents()->get();
        // Cleared only when there is at least one document and every one is Received + Valid.
        $cleared = $docs->isNotEmpty() && $docs->every(
            fn ($d) => $d->status === 'Received' && $d->validation === 'Valid'
        );

        $tracker = $transaction->activity_tracker ?? [];
        $audits = [];

        $apply = function (array $node, string $label) use ($cleared, &$audits) {
            $target = $cleared ? 'Yes' : 'No';
            $old = $node['docs_cleared'] ?? '';
            if ($old === $target) {
                return $node;
            }
            $node['docs_cleared'] = $target;
            $audits[] = ['field' => trim("$label Valid Docs Cleared from Agent"), 'old' => $old, 'new' => $target];

            // Final Validation → Pending immediately after clearance becomes Yes (never overrides Done).
            if ($cleared && ($node['final_validation'] ?? '') !== 'Done' && ($node['final_validation'] ?? '') !== 'Pending') {
                $fvOld = $node['final_validation'] ?? '';
                $node['final_validation'] = 'Pending';
                $audits[] = ['field' => trim("$label Final Validation"), 'old' => $fvOld, 'new' => 'Pending'];
            }

            return $node;
        };

        $tracker = $apply($tracker, '');

        // Preconstruction tracks clearance per commission term; mirror onto each.
        if (Transaction::isPreconType($transaction->type)) {
            $count = (int) ($transaction->precon_term_count ?? 0);
            $terms = $tracker['term_tracker'] ?? [];
            for ($k = 1; $k <= $count; $k++) {
                $terms[$k] = $apply(is_array($terms[$k] ?? null) ? $terms[$k] : [], "Term {$k} —");
            }
            if ($count > 0) {
                $tracker['term_tracker'] = $terms;
            }
        }

        if (empty($audits)) {
            return; // nothing changed
        }

        $transaction->update(['activity_tracker' => $tracker]);

        foreach ($audits as $a) {
            $this->audit->record($transaction, [
                'section' => 'Quick Actions — Agent FAQ', 'source' => 'System',
                'action' => 'Status changed', 'field' => $a['field'], 'old' => $a['old'], 'new' => $a['new'],
            ]);
        }
    }
}
