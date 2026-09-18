import { formatCents } from '@fmp/shared';
import { api } from './api';

/* ------------------------------------------------------------------ */
/* Label prefs, saved in the Print center (store settings bag)         */
/* ------------------------------------------------------------------ */

/** Repair claim tag — always printed on 50 × 80 mm stock. */
export interface TagPrefs {
  date?: boolean;
  ticket?: boolean;
  customer?: boolean;
  phone?: boolean;
  device?: boolean;
  repair?: boolean;
  passcode?: boolean;
  notes?: boolean;
  promise?: boolean;
  barcode?: boolean;
  price?: boolean;
}

/** Serialized device price label — always 50 × 30 mm. */
export interface DeviceLabelPrefs {
  carrier?: boolean;
  storage?: boolean;
  condition?: boolean;
  barcode?: boolean;
  imei?: boolean;
  price?: boolean;
}

/** Parts / accessories price label — always 50 × 30 mm. */
export interface InventoryLabelPrefs {
  sku?: boolean;
  barcode?: boolean;
  price?: boolean;
}

export interface LabelPrefs {
  tag?: TagPrefs;
  device?: DeviceLabelPrefs;
  inventory?: InventoryLabelPrefs;
}

export const TAG_DEFAULTS: Required<TagPrefs> = {
  date: true,
  ticket: true,
  customer: true,
  phone: true,
  device: true,
  repair: true,
  passcode: false,
  notes: false,
  promise: false,
  barcode: true,
  price: true,
};

export const DEVICE_LABEL_DEFAULTS: Required<DeviceLabelPrefs> = {
  carrier: true,
  storage: true,
  condition: true,
  barcode: true,
  imei: true,
  price: true,
};

export const INVENTORY_LABEL_DEFAULTS: Required<InventoryLabelPrefs> = {
  sku: true,
  barcode: true,
  price: true,
};

let prefs: LabelPrefs = {};
/** Cache the saved label prefs so every Label button prints with them. */
export function setLabelPrefs(p?: LabelPrefs | null) {
  prefs = p ?? {};
}

/** The cached claim-tag prefs with defaults filled in, for on-screen previews. */
export function getTagPrefs(): Required<TagPrefs> {
  return { ...TAG_DEFAULTS, ...prefs.tag };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ------------------------------------------------------------------ */
/* Code 128 — real, scannable barcodes with no library                 */
/* ------------------------------------------------------------------ */

// Standard Code 128 element widths: 6 per symbol (bar/space alternating), stop has 7.
const C128 = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112'
).split(' ');

/**
 * Element widths (bar, space, bar, …) for a Code 128 barcode of the given
 * text — code C for digit runs, code B otherwise. Returns null when the text
 * can't be encoded.
 */
export function code128Widths(data: string): number[] | null {
  if (!data) return null;
  const codes: number[] = [];
  if (/^\d{4,}$/.test(data)) {
    codes.push(105); // start C
    const pairEnd = data.length - (data.length % 2);
    for (let i = 0; i < pairEnd; i += 2) codes.push(Number(data.slice(i, i + 2)));
    if (data.length % 2 === 1) {
      codes.push(100); // switch to B for the odd trailing digit
      codes.push(data.charCodeAt(data.length - 1) - 32);
    }
  } else {
    codes.push(104); // start B
    for (const ch of data) {
      const v = ch.charCodeAt(0) - 32;
      if (v < 0 || v > 94) return null;
      codes.push(v);
    }
  }
  let sum = codes[0]!;
  for (let i = 1; i < codes.length; i++) sum += codes[i]! * i;
  codes.push(sum % 103);
  codes.push(106); // stop
  const widths: number[] = [];
  for (const c of codes) for (const d of C128[c]!) widths.push(Number(d));
  return widths;
}

/** Barcode as flex spans that fill the label width — bars first, alternating. */
function barcodeHtml(data: string, heightMm: number): string {
  const widths = code128Widths(data);
  if (!widths) return '';
  const spans = widths
    .map((w, i) => `<span style="flex:${w};background:${i % 2 === 0 ? '#000' : 'transparent'}"></span>`)
    .join('');
  return `<div style="display:flex;height:${heightMm}mm;margin:1.2mm 0.5mm 0.4mm">${spans}</div>`;
}

/** The self-contained page a label prints from: @page sizes it, the script prints it on load. */
function labelDocument(title: string, sizeH: '30mm' | '80mm', style: string, bodyHtml: string): string {
  return `<!doctype html><html><head><title>${esc(title)}</title><style>
    @page { size: 50mm ${sizeH}; margin: 2mm; }
    body { font-family: -apple-system, 'Segoe UI', sans-serif; margin: 0; width: 46mm; color: #000; }
    ${style}
  </style></head><body>
    ${bodyHtml}
    <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 300); };</script>
  </body></html>`;
}

function openLabelWindow(title: string, sizeH: '30mm' | '80mm', style: string, bodyHtml: string): boolean {
  const w = window.open('', '_blank', 'width=420,height=320');
  if (!w) return false;
  w.document.write(labelDocument(title, sizeH, style, bodyHtml));
  w.document.close();
  return true;
}

function logLabel(name: string, detail: string, payload: Record<string, unknown>) {
  void api('/api/print/log', {
    method: 'POST',
    body: JSON.stringify({ kind: 'label', name, detail: `${detail} · browser`, payload }),
  }).catch(() => {});
}

/**
 * Whether the store PC's print bridge is online, cached so a tap can decide synchronously:
 * the browser print dialog only opens inside the tap that asked for it, so the choice
 * between "send to the bridge" and "open the dialog" cannot wait for a network round trip.
 */
let bridgeOnline = false;
let bridgeCheckedAt = 0;
export async function refreshBridgeStatus(): Promise<boolean> {
  bridgeCheckedAt = Date.now();
  try {
    bridgeOnline = (await api<{ bridgeOnline: boolean }>('/api/print/status')).bridgeOnline;
  } catch {
    bridgeOnline = false;
  }
  return bridgeOnline;
}

interface LabelLog {
  name: string;
  detail: string;
  payload: Record<string, unknown>;
}

/**
 * Print a label: through the bridge when it is online (works from an iPad, the label
 * printer sits on the store PC), otherwise through this browser's print dialog.
 * Returns false only when the dialog could not open.
 */
function printLabelDoc(title: string, sizeH: '30mm' | '80mm', style: string, bodyHtml: string, log: LabelLog | null): boolean {
  if (Date.now() - bridgeCheckedAt > 30_000) void refreshBridgeStatus();
  if (bridgeOnline) {
    const html = labelDocument(title, sizeH, style, bodyHtml);
    void api<{ printed: boolean }>('/api/print/label', {
      method: 'POST',
      body: JSON.stringify({ name: log?.name ?? title, detail: log?.detail ?? null, html, payload: log?.payload ?? null }),
    })
      .then((r) => {
        if (r.printed) return;
        // the bridge dropped between checks: fall back to the dialog (may be blocked outside a tap)
        bridgeOnline = false;
        if (openLabelWindow(title, sizeH, style, bodyHtml) && log) logLabel(log.name, log.detail, log.payload);
      })
      .catch(() => {
        bridgeOnline = false;
        if (openLabelWindow(title, sizeH, style, bodyHtml) && log) logLabel(log.name, log.detail, log.payload);
      });
    return true;
  }
  const opened = openLabelWindow(title, sizeH, style, bodyHtml);
  if (opened && log) logLabel(log.name, log.detail, log.payload);
  return opened;
}

/* ------------------------------------------------------------------ */
/* Repair claim tag — 50 × 80 mm                                       */
/* ------------------------------------------------------------------ */

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

/**
 * Claim tag in the approved layout, opened as a print-ready window sized for
 * 50 × 80 mm Niimbot stock. Which lines print is controlled by the Print
 * center's claim-tag template. Native Niimbot printing lands in the bridge
 * once validated on the store's printer model.
 */
export function printTicketLabel(fields: TicketLabelFields, opts?: { skipLog?: boolean }) {
  const on = (k: keyof TagPrefs): boolean => prefs.tag?.[k] ?? TAG_DEFAULTS[k];

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
  if (on('barcode')) rows.push(barcodeHtml(fields.number, 8));
  if (on('price') && fields.priceText) {
    const status = fields.paid === true ? 'PAID' : fields.paid === false ? 'UNPAID' : '';
    rows.push(
      `<div class="pricebox"><span class="price">${esc(fields.priceText)}</span><span class="status">${status}</span></div>`,
    );
  }

  printLabelDoc(
    fields.number,
    '80mm',
    `
    .date { font-size: 10pt; font-weight: 700; }
    .tkt { font-size: 8.5pt; font-weight: 700; color: #444; }
    .name { font-size: 16pt; font-weight: 800; line-height: 1.05; letter-spacing: -0.01em; margin-top: 0.6mm; }
    .phone { font-size: 13pt; font-weight: 700; }
    .rule { border-top: 1.2pt solid #000; margin: 1.2mm 0; }
    .dev { font-size: 11pt; font-weight: 700; line-height: 1.1; }
    .rep { font-size: 11pt; font-weight: 800; line-height: 1.1; text-transform: uppercase; letter-spacing: -0.01em; }
    .pass { font-size: 10pt; font-weight: 700; margin-top: 0.6mm; }
    .notes { font-size: 7.5pt; line-height: 1.25; margin-top: 1mm; border-top: 0.5pt dotted #000; padding-top: 0.8mm; }
    .prom { font-size: 7.5pt; font-weight: 600; margin-top: 0.6mm; }
    .pricebox { display: flex; align-items: center; justify-content: space-between; gap: 2mm; border: 1.6pt solid #000; padding: 0.8mm 1.6mm; margin-top: 1.4mm; }
    .price { font-size: 14pt; font-weight: 800; }
    .status { font-size: 8pt; font-weight: 800; letter-spacing: 0.08em; }
    `,
    rows.join('\n'),
    opts?.skipLog ? null : { name: `Claim tag — ${fields.number}`, detail: '50 × 80 mm', payload: { type: 'tag', ...fields } },
  );
}

/* ------------------------------------------------------------------ */
/* Device price label — 50 × 30 mm                                     */
/* ------------------------------------------------------------------ */

export interface DeviceLabelFields {
  name: string;
  storage?: string | null;
  carrier?: string | null;
  conditionGrade?: string | null;
  imei?: string | null;
  priceCents: number;
}

/** Serialized-stock price label (phones, trade-ins) on 50 × 30 mm stock. */
export function printDeviceLabel(fields: DeviceLabelFields, opts?: { skipLog?: boolean }) {
  const on = (k: keyof DeviceLabelPrefs): boolean => prefs.device?.[k] ?? DEVICE_LABEL_DEFAULTS[k];
  const specs = [
    on('carrier') ? fields.carrier : null,
    on('storage') ? fields.storage : null,
    on('condition') && fields.conditionGrade ? `Grade ${fields.conditionGrade}` : null,
  ].filter(Boolean) as string[];

  const rows: string[] = [
    `<div class="top"><span class="model">${esc(fields.name)}</span>${on('price') ? `<span class="price">${formatCents(fields.priceCents)}</span>` : ''}</div>`,
  ];
  if (specs.length > 0) rows.push(`<div class="spec">${esc(specs.join(' · '))}</div>`);
  if (on('barcode') && fields.imei) rows.push(barcodeHtml(fields.imei, 5));
  if (on('imei') && fields.imei) rows.push(`<div class="imei">${esc(fields.imei)}</div>`);

  printLabelDoc(
    fields.name,
    '30mm',
    `
    .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 2mm; }
    .model { font-size: 10pt; font-weight: 800; line-height: 1.08; letter-spacing: -0.01em; }
    .price { font-size: 10pt; font-weight: 800; white-space: nowrap; }
    .spec { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; margin-top: 1mm; }
    .imei { font-size: 7.5pt; font-weight: 700; letter-spacing: 0.06em; text-align: center; margin-top: 0.6mm; }
    `,
    rows.join('\n'),
    opts?.skipLog ? null : { name: `Device label — ${fields.name}`, detail: '50 × 30 mm', payload: { type: 'device', ...fields } },
  );
}

/* ------------------------------------------------------------------ */
/* Inventory / price label — 50 × 30 mm                                */
/* ------------------------------------------------------------------ */

export interface InventoryLabelFields {
  name: string;
  sku?: string | null;
  priceCents: number;
}

/** Parts and accessories price label on 50 × 30 mm stock. */
export function printInventoryLabel(fields: InventoryLabelFields, opts?: { skipLog?: boolean }) {
  const on = (k: keyof InventoryLabelPrefs): boolean => prefs.inventory?.[k] ?? INVENTORY_LABEL_DEFAULTS[k];

  const rows: string[] = [`<div class="model">${esc(fields.name)}</div>`];
  if (on('barcode') && fields.sku) rows.push(barcodeHtml(fields.sku, 5));
  const bottom: string[] = [];
  if (on('sku') && fields.sku) bottom.push(`<span class="sku">${esc(fields.sku)}</span>`);
  if (on('price')) bottom.push(`<span class="price">${formatCents(fields.priceCents)}</span>`);
  if (bottom.length > 0) rows.push(`<div class="bottom">${bottom.join('')}</div>`);

  printLabelDoc(
    fields.name,
    '30mm',
    `
    .model { font-size: 9.5pt; font-weight: 700; line-height: 1.15; max-height: 9mm; overflow: hidden; }
    .bottom { display: flex; align-items: baseline; justify-content: space-between; gap: 2mm; margin-top: 2mm; }
    .sku { font-size: 7.5pt; font-weight: 700; letter-spacing: 0.05em; color: #333; }
    .price { font-size: 12pt; font-weight: 800; margin-left: auto; }
    `,
    rows.join('\n'),
    opts?.skipLog ? null : { name: `Price label — ${fields.name}`, detail: '50 × 30 mm', payload: { type: 'inventory', ...fields } },
  );
}

/** Reprint a queued label from its stored payload, whatever its type. */
export function reprintLabelPayload(payload: Record<string, unknown>) {
  if (payload.type === 'device') printDeviceLabel(payload as unknown as DeviceLabelFields, { skipLog: true });
  else if (payload.type === 'inventory') printInventoryLabel(payload as unknown as InventoryLabelFields, { skipLog: true });
  else printTicketLabel(payload as unknown as TicketLabelFields, { skipLog: true });
}
