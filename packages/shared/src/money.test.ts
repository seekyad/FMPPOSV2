import { describe, expect, it } from 'vitest';
import {
  changeCents,
  computeTotals,
  expectedInDrawer,
  formatCents,
  parseDollars,
  taxCents,
  tradeInOffer,
} from './money';

describe('formatCents / parseDollars', () => {
  it('formats cents as dollars', () => {
    expect(formatCents(15264)).toBe('$152.64');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(-4900)).toBe('-$49.00');
  });

  it('parses dollar strings', () => {
    expect(parseDollars('12.50')).toBe(1250);
    expect(parseDollars('$310')).toBe(31000);
    expect(parseDollars('0.1')).toBe(10);
    expect(parseDollars('abc')).toBeNull();
    expect(parseDollars('')).toBeNull();
    expect(parseDollars('1.234')).toBeNull();
  });
});

describe('tax', () => {
  it('computes 6% like the design mock ($144.00 -> $8.64)', () => {
    expect(taxCents(14400, 600)).toBe(864);
  });

  it('rounds half-up on fractional cents', () => {
    // 1.05 * 6% = 6.3c -> 6c ; 1.25 * 6% = 7.5c -> 8c
    expect(taxCents(105, 600)).toBe(6);
    expect(taxCents(125, 600)).toBe(8);
  });

  it('rejects non-integer amounts', () => {
    expect(() => taxCents(100.5, 600)).toThrow();
  });
});

describe('computeTotals', () => {
  const rate = 600;

  it('matches the design mock: $129 repair + $15 accessory at 6% = $152.64', () => {
    const totals = computeTotals(
      [
        { qty: 1, unitCents: 12900, taxable: true },
        { qty: 1, unitCents: 1500, taxable: true },
      ],
      rate,
    );
    expect(totals.subtotalCents).toBe(14400);
    expect(totals.taxCents).toBe(864);
    expect(totals.totalCents).toBe(15264);
  });

  it('does not tax non-taxable lines', () => {
    const totals = computeTotals(
      [
        { qty: 1, unitCents: 10000, taxable: true },
        { qty: 1, unitCents: 5000, taxable: false },
      ],
      rate,
    );
    expect(totals.taxCents).toBe(600);
    expect(totals.totalCents).toBe(15600);
  });

  it('applies line discounts before tax', () => {
    const totals = computeTotals([{ qty: 2, unitCents: 5000, taxable: true, discountCents: 1000 }], rate);
    expect(totals.discountCents).toBe(1000);
    expect(totals.taxableCents).toBe(9000);
    expect(totals.taxCents).toBe(540);
    expect(totals.totalCents).toBe(9540);
  });

  it('caps line discount at the line total', () => {
    const totals = computeTotals([{ qty: 1, unitCents: 500, taxable: true, discountCents: 900 }], rate);
    expect(totals.totalCents).toBe(0);
  });

  it('applies sale-level discount proportionally to the taxable base', () => {
    // $100 taxable + $100 non-taxable, $20 off the sale -> $10 comes off taxable
    const totals = computeTotals(
      [
        { qty: 1, unitCents: 10000, taxable: true },
        { qty: 1, unitCents: 10000, taxable: false },
      ],
      rate,
      2000,
    );
    expect(totals.taxableCents).toBe(9000);
    expect(totals.taxCents).toBe(540);
    expect(totals.totalCents).toBe(18540);
  });

  it('handles an empty sale', () => {
    const totals = computeTotals([], rate);
    expect(totals.totalCents).toBe(0);
    expect(totals.taxCents).toBe(0);
  });
});

describe('changeCents', () => {
  it('gives change when overpaid and negative when short', () => {
    expect(changeCents(2000, 1526)).toBe(474);
    expect(changeCents(1000, 1526)).toBe(-526);
  });
});

describe('tradeInOffer', () => {
  // Design mock: base $310, Good/Fair/Broken = 100/75/40%, credit +10%
  it('matches the design mock values', () => {
    expect(tradeInOffer(31000, 'good', 'cash')).toBe(31000);
    expect(tradeInOffer(31000, 'fair', 'cash')).toBe(23250);
    expect(tradeInOffer(31000, 'broken', 'cash')).toBe(12400);
    expect(tradeInOffer(31000, 'good', 'credit')).toBe(34100);
  });

  it('applies credit bonus after the condition multiplier', () => {
    expect(tradeInOffer(31000, 'fair', 'credit')).toBe(25575);
  });
});

describe('expectedInDrawer', () => {
  it('matches the design Reports mock: 200 float + 742 cash - 310 payouts - 49 refunds = 583', () => {
    expect(
      expectedInDrawer({
        openingFloatCents: 20000,
        cashSalesCents: 74200,
        cashRefundsCents: 4900,
        paidInCents: 0,
        paidOutCents: 31000,
      }),
    ).toBe(58300);
  });
});
