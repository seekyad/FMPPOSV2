import { formatCents } from '@fmp/shared';

export interface ReceiptData {
  header: string;
  address?: string | null;
  phone?: string | null;
  ticketNumber: string;
  cashier: string;
  customer?: string | null;
  customerPhone?: string | null;
  createdAt: Date;
  lines: Array<{ description: string; qty: number; totalCents: number }>;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  payments: Array<{ method: string; amountCents: number; tenderedCents?: number | null; changeCents?: number | null }>;
  terms?: string | null;
  footer?: string | null;
  refund?: boolean;
  /** print-center prefs baked in by buildReceipt */
  paperWidth?: 80 | 58;
  kickDrawer?: boolean;
}

/** chars per line: 80mm Rongta font A = 42, 58mm = 32 */
const widthOf = (r: ReceiptData) => (r.paperWidth === 58 ? 32 : 42);

function row(width: number, left: string, right: string): string {
  if (left.length + right.length + 1 > width) return [...wrap(width,left), ...wrap(width,right)].join('\n');
  const space = Math.max(1, width - left.length - right.length);
  return left + ' '.repeat(space) + right;
}

function center(width: number, text: string): string {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad) + text;
}

function wrap(width: number, text: string): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.flatMap(line => line.match(new RegExp('.{1,' + width + '}', 'g')) ?? []);
}

/** Plain-text body shared by the browser fallback and the ESC/POS job. */
const PAYMENT_LABELS: Record<string, string> = { store_credit: 'Store credit', zelle: 'Zelle', cash_app: 'Cash App', tap: 'Tap' };

export function receiptText(r: ReceiptData): string {
  const W = widthOf(r);
  const out: string[] = [];
  const pushCentered = (txt: string) => {
    for (const l of wrap(W, txt)) out.push(center(W, l));
  };
  if (r.header) pushCentered(r.header);
  if (r.address) pushCentered(r.address);
  if (r.phone) pushCentered(r.phone);
  out.push('-'.repeat(W));
  out.push(row(W, `${r.refund ? 'REFUND ' : ''}Ticket #${r.ticketNumber}`, r.createdAt.toLocaleDateString('en-US')));
  out.push(row(W, `Cashier: ${r.cashier}`, r.createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })));
  if (r.customer) out.push(row(W, 'Customer:', r.customer));
  if (r.customer && r.customerPhone) out.push(row(W, 'Phone:', r.customerPhone));
  out.push('-'.repeat(W));
  for (const line of r.lines) {
    const desc = line.qty > 1 ? `${line.qty} x ${line.description}` : line.description;
    out.push(row(W, desc.slice(0, W - 10), formatCents(line.totalCents)));
  }
  out.push('-'.repeat(W));
  out.push(row(W, 'Subtotal', formatCents(r.subtotalCents)));
  if (r.discountCents > 0) out.push(row(W, 'Discount', `-${formatCents(r.discountCents)}`));
  out.push(row(W, 'Tax', formatCents(r.taxCents)));
  out.push(row(W, 'TOTAL', formatCents(r.totalCents)));
  out.push('');
  for (const p of r.payments) {
    const label = PAYMENT_LABELS[p.method] ?? p.method[0]!.toUpperCase() + p.method.slice(1);
    out.push(row(W, label, formatCents(p.amountCents)));
    if (p.method === 'cash' && p.tenderedCents != null) {
      out.push(row(W, '  Tendered', formatCents(p.tenderedCents)));
      out.push(row(W, '  Change', formatCents(p.changeCents ?? 0)));
    }
  }
  if (r.terms || r.footer) {
    out.push('');
    out.push(NOTES_RULE.repeat(W));
  }
  if (r.terms) out.push(...wrap(W, r.terms));
  if (r.footer) {
    if (r.terms) out.push('');
    pushCentered(r.footer);
  }
  return out.join('\n');
}

/** The receipt's notes (terms + footer) follow a dotted rule; screens render them in a readable face. */
export const NOTES_RULE = '.';
export function splitReceiptNotes(text: string): { body: string; notes: string | null } {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.length >= 10 && /^\.+$/.test(l));
  if (at < 0) return { body: text, notes: null };
  return { body: lines.slice(0, at).join('\n').replace(/\n+$/, ''), notes: lines.slice(at + 1).join('\n').trim() };
}

/** ESC/POS job (base64) that only pulses the cash drawer open — nothing is printed. */
export function drawerKickEscpos(): string {
  return Buffer.from([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa]).toString('base64');
}

/** ESC/POS byte stream (base64) for the Rongta: init, text, feed, cut, optional drawer kick. */
export function receiptEscpos(r: ReceiptData, kickDrawer: boolean): string {
  const ESC = 0x1b;
  const GS = 0x1d;
  const bytes: number[] = [];
  const push = (...b: number[]) => bytes.push(...b);
  const text = (s: string) => push(...Array.from(Buffer.from(s + '\n', 'ascii')));

  push(ESC, 0x40); // init
  if (kickDrawer) push(ESC, 0x70, 0x00, 0x19, 0xfa); // drawer pulse on pin 2
  push(ESC, 0x61, 0x00); // left align (we pre-format columns)
  const W = widthOf(r);
  for (const line of receiptText({ ...r, terms: null, footer: null }).split('\n')) text(line);
  if (r.terms || r.footer) {
    text('');
    if (r.terms) {
      push(ESC, 0x21, 0x18); // emphasized + double height: the notes read apart from the columns
      for (const line of wrap(W, r.terms)) text(line);
      push(ESC, 0x21, 0x00);
    }
    if (r.footer) {
      if (r.terms) text('');
      push(ESC, 0x61, 0x01, ESC, 0x21, 0x08); // centered, emphasized
      for (const line of wrap(W, r.footer)) text(line);
      push(ESC, 0x21, 0x00, ESC, 0x61, 0x00);
    }
  }
  push(0x0a, 0x0a, 0x0a);
  push(GS, 0x56, 0x42, 0x00); // partial cut
  return Buffer.from(bytes).toString('base64');
}
