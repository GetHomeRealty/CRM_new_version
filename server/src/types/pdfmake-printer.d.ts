/**
 * Server-side pdfmake (`pdfmake` 0.3, whose root export is a configured singleton).
 *
 * `@types/pdfmake` only covers the browser build under `pdfmake/build/pdfmake`. This file used to
 * declare `pdfmake/js/printer` and its 0.2-era `createPdfKitDocument` stream. That entry still exists
 * in 0.3 but no longer works — the constructor does not build the url resolver it then dereferences,
 * so anything written against this declaration threw on the first call. Nothing had used it.
 */
declare module 'pdfmake' {
  import type { TDocumentDefinitions } from 'pdfmake/interfaces';

  interface PdfMakeDocument {
    getBuffer(): Promise<Uint8Array>;
  }

  interface PdfMake {
    /** Register font families; the 14 standard PDF fonts need no files. */
    addFonts(fonts: Record<string, { normal: string; bold: string; italics: string; bolditalics: string }>): void;
    /** Return false to refuse an external URL while building a document. */
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    /** Return false to refuse a local filesystem path while building a document. */
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
    createPdf(definition: TDocumentDefinitions): PdfMakeDocument;
  }

  const pdfMake: PdfMake;
  export default pdfMake;
}
