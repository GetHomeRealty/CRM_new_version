// Opens populated document HTML in a new window and triggers the browser's
// Print dialog (which includes "Save as PDF"). Inline styles in the markup
// carry over, so the printout matches the on-screen document.
export function printDoc(title: string, html: string, autoPrint = true): void {
  const w = window.open('', '_blank', 'width=840,height=940');
  if (!w) {
    alert('Please allow pop-ups to print/download this document.');
    return;
  }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:"Inter",Arial,sans-serif;color:#0f172a;margin:28px;font-size:13px;line-height:1.5}
      table{width:100%;border-collapse:collapse;margin-top:8px}
      th,td{border:1px solid #e6e8ef;padding:7px 9px;text-align:left;font-size:12px}
      th{background:#f3f5f9}
      h1,h2,h3{margin:0}
      @media print{body{margin:0}}
    </style></head><body>${html}</body></html>`);
  w.document.close();
  w.focus();
  if (autoPrint) {
    setTimeout(() => { try { w.print(); } catch { /* user can print manually */ } }, 350);
  }
}
