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
  /** true = PAID, false = UNPAID in the price box; omit to leave the status off */
  paid?: boolean | null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Label printing fallback: opens a print-ready window sized for the Niimbot
 * label picked in the Print center (50×30 or 50×80 mm). Which lines print is
 * controlled by the Print center's claim-tag template. Native Niimbot printing
 * lands in the bridge once validated on the store's printer model.
 */
export function printTicketLabel(fields: TicketLabelFields, opts?: { skipLog?: boolean }) {
  const tall = prefs.size === '50x80';
  const size = tall ? { w: '50mm', h: '80mm' } : { w: '50mm', h: '30mm' };
  // typography scales with the stock: the 50x80 tag matches the approved design
  const fs = tall
    ? { date: '10pt', tkt: '8.5pt', name: '16pt', phone: '13pt', dev: '11pt', rep: '11pt', pass: '10pt', small: '7.5pt', price: '14pt', status: '8pt' }
    : { date: '7.5pt', tkt: '7pt', name: '11pt', phone: '9.5pt', dev: '8.5pt', rep: '8.5pt', pass: '8pt', small: '6.5pt', price: '10pt', status: '6.5pt' };

  const head: string[] = [];
  if (on('date')) {
    const d = new Date();
    head.push(
      `<div class="date">${d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>`,
    );
  }
  if (on('ticket')) head.push(`<div class="tkt">Ticket ${esc(fields.number)}</div>`);
  if (on('customer') && fields.customer) head.push(`<div class="name">${esc(fields.customer)}</div>`);
  if (on('phone') && fields.phone) head.push(`<div class="phone">${esc(fields.phone)}</div>`);

  const body: string[] = [];
  if (on('device') && fields.device) body.push(`<div class="dev">${esc(fields.device)}</div>`);
  if (on('repair') && fields.issue) body.push(`<div class="rep">${esc(fields.issue)}</div>`);
  if (on('passcode') && fields.passcode) body.push(`<div class="pass">Passcode ${esc(fields.passcode)}</div>`);
  if (on('notes') && fields.notes) body.push(`<div class="notes">${esc(fields.notes)}</div>`);
  if (on('promise') && fields.promised) body.push(`<div class="prom">Promised: ${esc(fields.promised)}</div>`);

  const rows = [...head];
  if (head.length > 0 && body.length > 0) rows.push('<div class="rule"></div>');
  rows.push(...body);
  if (on('price') && fields.priceText) {
    const status = fields.paid === true ? 'PAID' : fields.paid === false ? 'UNPAID' : '';
    rows.push(
      `<div class="pricebox"><span class="price">${esc(fields.priceText)}</span><span class="status">${status}</span></div>`,
    );
  }

  const w = window.open('', '_blank', 'width=420,height=320');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>${esc(fields.number)}</title><style>
    @page { size: ${size.w} ${size.h}; margin: 2mm; }
    body { font-family: -apple-system, 'Segoe UI', sans-serif; margin: 0; width: 46mm; color: #000; }
    .date { font-size: ${fs.date}; font-weight: 700; }
    .tkt { font-size: ${fs.tkt}; font-weight: 700; color: #444; }
    .name { font-size: ${fs.name}; font-weight: 800; line-height: 1.05; letter-spacing: -0.01em; margin-top: 0.6mm; }
    .phone { font-size: ${fs.phone}; font-weight: 700; }
    .rule { border-top: 1.2pt solid #000; margin: 1.2mm 0; }
    .dev { font-size: ${fs.dev}; font-weight: 700; line-height: 1.1; }
    .rep { font-size: ${fs.rep}; font-weight: 800; line-height: 1.1; text-transform: uppercase; letter-spacing: -0.01em; }
    .pass { font-size: ${fs.pass}; font-weight: 700; margin-top: 0.6mm; }
    .notes { font-size: ${fs.small}; line-height: 1.25; margin-top: 1mm; border-top: 0.5pt dotted #000; padding-top: 0.8mm; }
    .prom { font-size: ${fs.small}; font-weight: 600; margin-top: 0.6mm; }
    .pricebox { display: flex; align-items: center; justify-content: space-between; gap: 2mm; border: 1.6pt solid #000; padding: 0.8mm 1.6mm; margin-top: 1.4mm; }
    .price { font-size: ${fs.price}; font-weight: 800; }
    .status { font-size: ${fs.status}; font-weight: 800; letter-spacing: 0.08em; }
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
