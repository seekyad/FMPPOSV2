import type { SaleLineKind } from '@fmp/shared';

export interface CartLine {
  key: string;
  kind: SaleLineKind;
  description: string;
  detail?: string;
  qty: number;
  unitCents: number;
  discountCents: number;
  taxable: boolean;
  inventoryItemId?: number | null;
  /** repair lines: ticket whose balance this pays */
  ticketId?: number | null;
  /** serialized devices can't have qty > 1 */
  serialized?: boolean;
}

export interface CartCustomer {
  id: number;
  name: string;
  phone?: string | null;
  storeCreditCents?: number;
}

let keyCounter = 0;
export function lineKey(): string {
  keyCounter += 1;
  return `L${Date.now()}-${keyCounter}`;
}

/**
 * Guardrail for phone inputs: digits only, capped at 10 (a leading 1 is
 * dropped), rendered progressively as (XXX) XXX-XXXX.
 */
export function formatPhoneInput(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('1')) d = d.slice(1);
  d = d.slice(0, 10);
  if (d.length === 0) return '';
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
