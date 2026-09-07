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
