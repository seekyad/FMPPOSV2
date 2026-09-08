import { formatCents } from '@fmp/shared';

export interface ReceiptData {
  header: string;
  address?: string | null;
  phone?: string | null;
  ticketNumber: string;
  cashier: string;
  customer?: string | null;
  createdAt: Date;
  lines: Array<{ description: string; qty: number; totalCents: number }>;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  payments: Array<{ method: string; amountCents: number; tenderedCents?: number | null; changeCents?: number | null }>;
  footer?: string | null;
  refund?: boolean;
}

const WIDTH = 42; // chars on 80mm Rongta at font A

function row(left: string, right: string): string {
  const space = Math.max(1, WIDTH - left.length - right.length);
  return left + ' '.repeat(space) + right;
}

function center(text: string): string {
  const pad = Math.max(0, Math.floor((WIDTH - text.length) / 2));
  return ' '.repeat(pad) + text;
}

/** Plain-text body shared by the browser fallback and the ESC/POS job. */
export function receiptText(r: ReceiptData): string {
  const out: string[] = [];
  out.push(center(r.header));
  if (r.address) out.push(center(r.address));
  if (r.phone) out.push(center(r.phone));
  out.push('-'.repeat(WIDTH));
  out.push(row(`${r.refund ? 'REFUND ' : ''}Ticket #${r.ticketNumber}`, r.createdAt.toLocaleDateString('en-US')));
  out.push(row(`Cashier: ${r.cashier}`, r.createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })));
  if (r.customer) out.push(row('Customer:', r.customer));
  out.push('-'.repeat(WIDTH));
  for (const line of r.lines) {
    const desc = line.qty > 1 ? `${line.qty} x ${line.description}` : line.description;
    out.push(row(desc.slice(0, WIDTH - 10), formatCents(line.totalCents)));
  }
  out.push('-'.repeat(WIDTH));
  out.push(row('Subtotal', formatCents(r.subtotalCents)));
  if (r.discountCents > 0) out.push(row('Discount', `-${formatCents(r.discountCents)}`));
  out.push(row('Tax', formatCents(r.taxCents)));
  out.push(row('TOTAL', formatCents(r.totalCents)));
  out.push('');
  for (const p of r.payments) {
    const label = p.method === 'store_credit' ? 'Store credit' : p.method[0]!.toUpperCase() + p.method.slice(1);
    out.push(row(label, formatCents(p.amountCents)));
    if (p.method === 'cash' && p.tenderedCents != null) {
      out.push(row('  Tendered', formatCents(p.tenderedCents)));
      out.push(row('  Change', formatCents(p.changeCents ?? 0)));
    }
  }
  if (r.footer) {
    out.push('');
    out.push(center(r.footer));
  }
  return out.join('\n');
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
  for (const line of receiptText(r).split('\n')) text(line);
  push(0x0a, 0x0a, 0x0a);
  push(GS, 0x56, 0x42, 0x00); // partial cut
  return Buffer.from(bytes).toString('base64');
}
