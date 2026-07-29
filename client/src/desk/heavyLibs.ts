/**
 * On-demand loaders for the three largest dependencies.
 *
 * Together these are roughly 315 kB gzipped — about half of what the browser used to download
 * before it could render anything — and each is reachable from a handful of screens:
 *
 *   pdf-lib   ~162 kB gz  filling the OREA 630 and 640 forms
 *   jspdf     ~111 kB gz  "print to PDF" on reports, invoices and MLS sheets
 *   twilio    ~ 43 kB gz  the in-browser dialer on the lead detail page
 *
 * Imported statically they land in whichever chunk touches them first, which put pdf-lib inside
 * the transaction detail route — the most-visited screen in the application. Loaded through these
 * helpers they become their own chunks, fetched the first time someone actually generates a PDF
 * or places a call, and cached from then on.
 *
 * Every caller already sits in an async function, so nothing changes for them beyond one `await`.
 * Going through this module rather than writing `import()` inline means a single shared chunk per
 * library instead of one per call site.
 */

/** pdf-lib — reading and filling existing AcroForm PDFs. */
export const loadPdfLib = (): Promise<typeof import('pdf-lib')> => import('pdf-lib');

/** jsPDF — generating PDFs from scratch or from rendered HTML. */
export const loadJsPdf = async (): Promise<typeof import('jspdf').jsPDF> => (await import('jspdf')).jsPDF;

/** Twilio Voice — the browser softphone. */
export const loadTwilioVoice = (): Promise<typeof import('@twilio/voice-sdk')> => import('@twilio/voice-sdk');
