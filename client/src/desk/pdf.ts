// PDF helpers for emailing / downloading documents.
//  - elementToPdfBase64: render a live DOM node to a PDF (base64, no data: prefix)
//  - downloadElementPdf: render a node to a PDF and trigger a browser download
//  - reactToPdfBase64: render a React element offscreen, then to a PDF
//  - bytesToBase64: base64-encode raw PDF bytes (e.g. from pdf-lib)
import type { jsPDF, HTMLOptions } from 'jspdf';   // types only — erased at build time
import { loadJsPdf } from './heavyLibs';
import { createRoot } from 'react-dom/client';
import type { ReactElement } from 'react';

const HTML_OPTS: HTMLOptions = {
  autoPaging: 'text',
  margin: [24, 24, 24, 24],
  width: 547,          // A4 width (595pt) minus 24pt margins each side
  windowWidth: 800,    // source width the node is laid out at
  html2canvas: { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false },
};

async function renderPdf(el: HTMLElement): Promise<jsPDF> {
  // jsPDF (and the html2canvas it pulls in) is fetched the first time a PDF is produced, rather
  // than by everyone who opens the application. See heavyLibs.
  const JsPDF = await loadJsPdf();
  const pdf = new JsPDF({ orientation: 'p', unit: 'pt', format: 'a4' });
  await pdf.html(el, HTML_OPTS);
  return pdf;
}

export async function elementToPdfBase64(el: HTMLElement): Promise<string> {
  const pdf = await renderPdf(el);
  const uri = pdf.output('datauristring');
  return uri.slice(uri.indexOf(',') + 1); // strip "data:application/pdf;base64,"
}

export async function downloadElementPdf(el: HTMLElement, filename: string): Promise<void> {
  const pdf = await renderPdf(el);
  pdf.save(filename);
}

export async function reactToPdfBase64(reactEl: ReactElement): Promise<string> {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:760px;background:#ffffff;padding:20px;'
    + 'font-family:Inter,Arial,sans-serif;color:#0f172a;font-size:13px;line-height:1.5;';
  document.body.appendChild(holder);
  const root = createRoot(holder);
  try {
    await new Promise<void>((resolve) => { root.render(reactEl); requestAnimationFrame(() => requestAnimationFrame(() => resolve())); });
    await new Promise((r) => setTimeout(r, 90)); // let fonts/layout settle
    return await elementToPdfBase64(holder);
  } finally {
    root.unmount();
    holder.remove();
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    // Spread of the chunked subarray is equivalent to the original
    // String.fromCharCode.apply(null, ...) and stays within the arg-count limit.
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
