import { api } from '@fmp/pos-client';

/** Claim-tag print settings, saved in the Print center (store settings bag). */
export interface TagPrefs {
  size?: '50x30' | '50x80';
  date?: boolean;
  ticket?: boolean;
  customer?: boolean;
  phone?: boolean;
  device?: boolean;
  repair?: boolean;
  passcode?: boolean;
  notes?: boolean;
  promise?: boolean;
  price?: boolean;
}

export const TAG_DEFAULTS: Required<Omit<TagPrefs, 'size'>> & { size: '50x30' | '50x80' } = {
  size: '50x30',
  date: true,
  ticket: true,
  customer: true,
  phone: true,
  device: true,
  repair: true,
  passcode: false,
  notes: false,
  promise: false,
  price: true,
};

let prefs: TagPrefs = {};
/** Cache the saved tag prefs so every Label button prints with them. */
export function setLabelPrefs(p?: TagPrefs | null) {
  prefs = p ?? {};
}
const on = (k: keyof Omit<TagPrefs, 'size'>): boolean => prefs[k] ?? TAG_DEFAULTS[k];

export interface TicketLabelFields {
  number: string;
  customer: string;
  device: string;
  issue: string;
  phone?: string | null;
  passcode?: string | null;
  notes?: string | null;
  promised?: string | null;
  priceText?: string | null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Label printing fallback: opens a print-ready window sized for the Niimbot
 * label picked in the Print center (50×30 or 50×80 mm). Which lines print is
 * controlled by the Print center's claim-tag template. Native Niimbot printing
 * lands in the bridge once validated on the store's printer model.
 */
export function printTicketLabel(fields: TicketLabelFields, opts?: { skipLog?: boolean }) {
  const size = prefs.size === '50x80' ? { w: '50mm', h: '80mm', bodyW: '46mm' } : { w: '50mm', h: '30mm', bodyW: '46mm' };
  const rows: string[] = [];
  if (on('date')) {
    const d = new Date();
    rows.push(
      `<div class="row">${d.toLocaleDateString('en-US')} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>`,
    );
  }
  if (on('ticket')) rows.push(`<div class="num">${esc(fields.number)}</div>`);
  if (on('customer') && fields.customer) rows.push(`<div class="name">${esc(fields.customer)}</div>`);
  if (on('phone') && fields.phone) rows.push(`<div class="row">${esc(fields.phone)}</div>`);
  if (on('device') && fields.device) rows.push(`<div class="row rule">${esc(fields.device)}</div>`);
  if (on('repair') && fields.issue) rows.push(`<div class="issue">${esc(fields.issue)}</div>`);
  if (on('passcode') && fields.passcode) rows.push(`<div class="row">Passcode ${esc(fields.passcode)}</div>`);
  if (on('notes') && fields.notes) rows.push(`<div class="notes">${esc(fields.notes)}</div>`);
  if (on('promise') && fields.promised) rows.push(`<div class="row">Promised: ${esc(fields.promised)}</div>`);
  if (on('price') && fields.priceText) rows.push(`<div class="price">${esc(fields.priceText)}</div>`);

  const w = window.open('', '_blank', 'width=420,height=320');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>${esc(fields.number)}</title><style>
    @page { size: ${size.w} ${size.h}; margin: 2mm; }
    body { font-family: -apple-system, 'Segoe UI', sans-serif; margin: 0; width: ${size.bodyW}; }
    .num { font-size: 14pt; font-weight: 800; }
    .name { font-size: 11pt; font-weight: 700; }
    .row { font-size: 8pt; margin-top: 1mm; }
    .rule { border-top: 0.4pt solid #000; padding-top: 1mm; }
    .issue { font-size: 9pt; font-weight: 600; margin-top: 1mm; text-transform: uppercase; }
    .notes { font-size: 7.5pt; margin-top: 1mm; border-top: 0.4pt dotted #000; padding-top: 1mm; }
    .price { font-size: 12pt; font-weight: 800; margin-top: 1.5mm; border: 1.2pt solid #000; padding: 0.5mm 1.5mm; display: inline-block; }
  </style></head><body>
    ${rows.join('\n')}
    <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 300); };</script>
  </body></html>`);
  w.document.close();

  if (!opts?.skipLog) {
    void api('/api/print/log', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'label',
        name: `Claim tag — ${fields.number}`,
        detail: `${prefs.size === '50x80' ? '50 × 80' : '50 × 30'} mm · browser`,
        payload: fields as unknown as Record<string, unknown>,
      }),
    }).catch(() => {});
  }
}
