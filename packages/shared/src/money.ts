/**
 * All monetary amounts in the system are integer US cents.
 * Tax rates and percentage bonuses are integer basis points (1% = 100 bp)
 * so every computation stays in integers until display.
 */

export type Cents = number;

export function assertCents(value: number): Cents {
  if (!Number.isInteger(value)) throw new Error(`Amount must be integer cents, got ${value}`);
  return value;
}

export function formatCents(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

/** Parse a user-typed dollar string ("12.5", "$12.50") into cents. Returns null when unparseable. */
export function parseDollars(input: string): Cents | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d*\.?\d{0,2}$/.test(cleaned) || cleaned === '' || cleaned === '.') return null;
  return Math.round(parseFloat(cleaned) * 100);
}

/** Tax on a taxable subtotal, half-up rounding (matches receipt expectations). */
export function taxCents(taxableSubtotal: Cents, rateBp: number): Cents {
  assertCents(taxableSubtotal);
  return Math.round((taxableSubtotal * rateBp) / 10000);
}

export interface SaleLineInput {
  qty: number;
  unitCents: Cents;
  taxable: boolean;
  /** line-level discount in cents, already applied per line total (not per unit) */
  discountCents?: Cents;
}

export interface SaleTotals {
  subtotalCents: Cents;
  discountCents: Cents;
  taxableCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
}

/**
 * Sale math: line totals - discounts, tax on the taxable portion, grand total.
 * A sale-level discount is applied proportionally against taxable amounts last.
 */
export function computeTotals(lines: SaleLineInput[], taxRateBp: number, saleDiscountCents: Cents = 0): SaleTotals {
  let subtotal = 0;
  let taxable = 0;
  let lineDiscounts = 0;
  for (const line of lines) {
    const gross = assertCents(line.unitCents) * line.qty;
    const disc = Math.min(line.discountCents ?? 0, gross);
    subtotal += gross;
    lineDiscounts += disc;
    if (line.taxable) taxable += gross - disc;
  }
  const netBeforeSaleDiscount = subtotal - lineDiscounts;
  const saleDisc = Math.min(saleDiscountCents, netBeforeSaleDiscount);
  // Sale-level discount reduces the taxable base proportionally.
  const taxableShare = netBeforeSaleDiscount > 0 ? Math.round((saleDisc * taxable) / netBeforeSaleDiscount) : 0;
  const taxableFinal = Math.max(taxable - taxableShare, 0);
  const tax = taxCents(taxableFinal, taxRateBp);
  return {
    subtotalCents: subtotal,
    discountCents: lineDiscounts + saleDisc,
    taxableCents: taxableFinal,
    taxCents: tax,
    totalCents: netBeforeSaleDiscount - saleDisc + tax,
  };
}

/** Change due when cash is tendered; negative means still owed. */
export function changeCents(tenderedCents: Cents, dueCents: Cents): Cents {
  return assertCents(tenderedCents) - assertCents(dueCents);
}

export type TradeInCondition = 'good' | 'fair' | 'broken';
export type TradeInPayout = 'cash' | 'credit';

export interface TradeInConfig {
  /** multipliers in basis points of base value: good=10000, fair=7500, broken=4000 by default */
  conditionBp: Record<TradeInCondition, number>;
  /** extra bonus when paid as store credit, in basis points (default 1000 = +10%) */
  creditBonusBp: number;
}

export const DEFAULT_TRADEIN_CONFIG: TradeInConfig = {
  conditionBp: { good: 10000, fair: 7500, broken: 4000 },
  creditBonusBp: 1000,
};

/** Suggested trade-in offer from the pricebook base value. */
export function tradeInOffer(
  baseCents: Cents,
  condition: TradeInCondition,
  payout: TradeInPayout,
  config: TradeInConfig = DEFAULT_TRADEIN_CONFIG,
): Cents {
  assertCents(baseCents);
  const afterCondition = Math.round((baseCents * config.conditionBp[condition]) / 10000);
  if (payout === 'credit') {
    return Math.round((afterCondition * (10000 + config.creditBonusBp)) / 10000);
  }
  return afterCondition;
}

export interface DrawerExpectation {
  openingFloatCents: Cents;
  cashSalesCents: Cents;
  cashRefundsCents: Cents;
  paidInCents: Cents;
  paidOutCents: Cents; // includes trade-in cash payouts
}

/** What should be in the drawer at close. */
export function expectedInDrawer(d: DrawerExpectation): Cents {
  return (
    d.openingFloatCents + d.cashSalesCents + d.paidInCents - d.cashRefundsCents - d.paidOutCents
  );
}
