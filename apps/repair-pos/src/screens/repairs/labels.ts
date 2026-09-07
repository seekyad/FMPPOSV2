/**
 * Label printing fallback: opens a print-ready window sized for a 50×30mm
 * Niimbot label. Native Niimbot printing lands in the bridge once validated
 * on the store's printer model.
 */
export function printTicketLabel(fields: { number: string; customer: string; device: string; issue: string; promised?: string }) {
  const w = window.open('', '_blank', 'width=420,height=280');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>${fields.number}</title><style>
    @page { size: 50mm 30mm; margin: 2mm; }
    body { font-family: -apple-system, 'Segoe UI', sans-serif; margin: 0; width: 46mm; }
    .num { font-size: 14pt; font-weight: 800; }
    .row { font-size: 8pt; margin-top: 1mm; }
    .issue { font-size: 9pt; font-weight: 600; margin-top: 1mm; }
  </style></head><body>
    <div class="num">${fields.number}</div>
    <div class="row">${fields.customer}</div>
    <div class="row">${fields.device}</div>
    <div class="issue">${fields.issue}</div>
    ${fields.promised ? `<div class="row">Promised: ${fields.promised}</div>` : ''}
    <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 300); };</script>
  </body></html>`);
  w.document.close();
}
