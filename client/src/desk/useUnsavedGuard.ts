import { useEffect } from 'react';

/**
 * Warn before leaving a form with edits that were never saved.
 *
 * Settings screens are long and every section has its own Save button, so the failure is ordinary
 * rather than exotic: type a signature, get distracted, navigate away, and the work is gone with no
 * indication it ever existed. Measured on 2026-08-04 — filled the signature box, moved to Leads,
 * came back, and the field was empty.
 *
 * WHAT THIS COVERS, AND WHAT IT CANNOT. `beforeunload` is the browser's own guard and catches
 * closing the tab, reloading, and following a link out of the application — the cases where the
 * work is unrecoverable. It does NOT catch navigation *within* the SPA, because blocking that needs
 * React Router's `useBlocker`, which only exists on a data router (`createBrowserRouter`); this
 * application mounts `BrowserRouter`, the declarative one. Converting the router is a change to
 * every route in both areas and is not worth making for a confirmation dialog.
 *
 * So this is deliberately the half that is free. The other half is why the screens also disable
 * their Save buttons until something is dirty — an unsaved edit is at least visible before you
 * leave it.
 *
 * The message is ignored by every current browser, which show their own fixed wording. It is still
 * returned because some older ones display it and the spec requires a non-empty return to trigger
 * the prompt at all.
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e: BeforeUnloadEvent): string => {
      e.preventDefault();
      e.returnValue = 'You have unsaved changes on this page.';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
