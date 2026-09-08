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
  price?: boolean;
}

/** Serialized device price label — always 50 × 30 mm. */
export interface DeviceLabelPrefs {
  carrier?: boolean;
  storage?: boolean;
  condition?: boolean;
  imei?: boolean;
  price?: boolean;
}

/** Parts / accessories price label — always 50 × 30 mm. */
export interface InventoryLabelPrefs {
  sku?: boolean;
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
  price: true,
};

export const DEVICE_LABEL_DEFAULTS: Required<DeviceLabelPrefs> = {
  carrier: true,
  storage: true,
  condition: true,
  imei: true,
  price: true,
};

export const INVENTORY_LABEL_DEFAULTS: Required<InventoryLabelPrefs> = {
  sku: true,
  price: true,
};

let prefs: LabelPrefs = {};
/** Cache the saved label prefs so every Label button prints with them. */
export function setLabelPrefs(p?: LabelPrefs | null) {
  prefs = p ?? {};
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function openLabelWindow(title: string, sizeH: '30mm' | '80mm', style: string, bodyHtml: string): boolean {
  const w = window.open('', '_blank', 'width=420,height=320');
  if (!w) return false;
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title><style>
    @page { size: 50mm ${sizeH}; margin: 2mm; }
    body { font-family: -apple-system, 'Segoe UI', sans-serif; margin: 0; width: 46mm; color: #000; }
    ${style}
  </style></head><body>
    ${bodyHtml}
    <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 300); };</script>
  </body></html>`);
  w.document.close();
  return true;
}

function logLabel(name: string, detail: string, payload: Record<string, unknown>) {
  void api('/api/print/log', {
    method: 'POST',
    body: JSON.stringify({ kind: 'label', name, detail, payload }),
  }).catch(() => {});
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
  if (on('price') && fields.priceText) {
    const status = fields.paid === true ? 'PAID' : fields.paid === false ? 'UNPAID' : '';
    rows.push(
      `<div class="pricebox"><span class="price">${esc(fields.priceText)}</span><span class="status">${status}</span></div>`,
    );
  }

  const opened = openLabelWindow(
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
  );
  if (opened && !opts?.skipLog) {
    logLabel(`Claim tag — ${fields.number}`, '50 × 80 mm · browser', { type: 'tag', ...fields });
  }
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
  if (on('imei') && fields.imei) rows.push(`<div class="imei">${esc(fields.imei)}</div>`);

  const opened = openLabelWindow(
    fields.name,
    '30mm',
    `
    .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 2mm; }
    .model { font-size: 10pt; font-weight: 800; line-height: 1.08; letter-spacing: -0.01em; }
    .price { font-size: 10pt; font-weight: 800; white-space: nowrap; }
    .spec { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; margin-top: 1mm; }
    .imei { font-size: 7.5pt; font-weight: 700; letter-spacing: 0.06em; text-align: center; margin-top: 2mm; border-top: 0.5pt solid #000; padding-top: 1mm; }
    `,
    rows.join('\n'),
  );
  if (opened && !opts?.skipLog) {
    logLabel(`Device label — ${fields.name}`, '50 × 30 mm · browser', { type: 'device', ...fields });
  }
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
  const bottom: string[] = [];
  if (on('sku') && fields.sku) bottom.push(`<span class="sku">${esc(fields.sku)}</span>`);
  if (on('price')) bottom.push(`<span class="price">${formatCents(fields.priceCents)}</span>`);
  if (bottom.length > 0) rows.push(`<div class="bottom">${bottom.join('')}</div>`);

  const opened = openLabelWindow(
    fields.name,
    '30mm',
    `
    .model { font-size: 9.5pt; font-weight: 700; line-height: 1.15; max-height: 9mm; overflow: hidden; }
    .bottom { display: flex; align-items: baseline; justify-content: space-between; gap: 2mm; margin-top: 2mm; }
    .sku { font-size: 7.5pt; font-weight: 700; letter-spacing: 0.05em; color: #333; }
    .price { font-size: 12pt; font-weight: 800; margin-left: auto; }
    `,
    rows.join('\n'),
  );
  if (opened && !opts?.skipLog) {
    logLabel(`Price label — ${fields.name}`, '50 × 30 mm · browser', { type: 'inventory', ...fields });
  }
}

/** Reprint a queued label from its stored payload, whatever its type. */
export function reprintLabelPayload(payload: Record<string, unknown>) {
  if (payload.type === 'device') printDeviceLabel(payload as unknown as DeviceLabelFields, { skipLog: true });
  else if (payload.type === 'inventory') printInventoryLabel(payload as unknown as InventoryLabelFields, { skipLog: true });
  else printTicketLabel(payload as unknown as TicketLabelFields, { skipLog: true });
}
