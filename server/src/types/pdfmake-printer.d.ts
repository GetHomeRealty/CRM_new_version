/** Server-side pdfmake printer (the built CJS entry; @types/pdfmake only covers the client build). */
declare module 'pdfmake/js/printer' {
  import type { TDocumentDefinitions } from 'pdfmake/interfaces';
  export default class PdfPrinter {
    constructor(fonts: Record<string, unknown>);
    createPdfKitDocument(doc: TDocumentDefinitions): NodeJS.ReadableStream & { end(): void };
  }
}
