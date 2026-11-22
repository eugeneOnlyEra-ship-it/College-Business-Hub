import { describe, expect, it } from 'vitest';
import { factSheet, stockReport, summarize, unknownAmounts, withPending } from './numbers';
import type { Ledger } from './types';

const NOW = new Date('2026-11-22T15:00:00');
const iso = (daysAgo: number, hour = 12) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

function ledger(): Ledger {
  return {
    business: { id: 'b1', name: 'Tuck Shop', category: 'snacks', closed: false },
    generatedAt: NOW.toISOString(),
    listings: [
      { id: 'sam', title: 'Samosa', kind: 'PRODUCT', unit: null, active: true, priceCents: 50, costCents: 25, stockQty: 40, lowStockAt: 15 },
      { id: 'soda', title: 'Soda', kind: 'PRODUCT', unit: null, active: true, priceCents: 80, costCents: 55, stockQty: 4, lowStockAt: 10 },
      { id: 'air', title: 'Airtime', kind: 'SERVICE', unit: null, active: true, priceCents: 100, costCents: null, stockQty: null, lowStockAt: null },
    ],
    entries: [
      { id: 'e1', source: 'STALL', type: 'SALE', listingId: 'sam', title: 'Samosa', quantity: 10, unitPriceCents: 50, unitCostCents: 25, feesCents: 0, note: '', at: iso(0, 10) },
      { id: 'e2', source: 'PAYPAL', type: 'SALE', listingId: 'soda', title: 'Soda', quantity: 2, unitPriceCents: 80, unitCostCents: 55, feesCents: 20, note: '', at: iso(0, 11) },
      { id: 'e3', source: 'STALL', type: 'SALE', listingId: 'air', title: 'Airtime', quantity: 3, unitPriceCents: 100, unitCostCents: null, feesCents: 0, note: '', at: iso(1) },
      { id: 'e4', source: 'STALL', type: 'SALE', listingId: 'soda', title: 'Soda', quantity: 12, unitPriceCents: 80, unitCostCents: 55, feesCents: 0, note: '', at: iso(3) },
      { id: 'e5', source: 'STALL', type: 'RESTOCK', listingId: 'sam', title: 'Samosa', quantity: 30, unitPriceCents: null, unitCostCents: 25, feesCents: 0, note: '', at: iso(2) },
      { id: 'old', source: 'STALL', type: 'SALE', listingId: 'sam', title: 'Samosa', quantity: 99, unitPriceCents: 50, unitCostCents: 25, feesCents: 0, note: '', at: iso(40) },
    ],
  };
}

describe('summarize', () => {
  it("works out today's profit from price, cost and fees", () => {
    const s = summarize(ledger(), 'today', NOW);
    // samosa 10 × (50 − 25) = 250; soda 2 × (80 − 55) − 20 fee = 30; total 280
    expect(s).toMatchObject({ sales: 2, units: 12, revenueCents: 660, costCents: 360, feesCents: 20, profitCents: 280, cashCents: 500, onlineCents: 160 });
  });
  it('ignores restocks and older sales, and flags items with no cost', () => {
    const week = summarize(ledger(), 'week', NOW);
    expect(week.units).toBe(27);
    expect(week.missingCost).toEqual(['Airtime']);
    expect(summarize(ledger(), 'yesterday', NOW).revenueCents).toBe(300);
  });
});

describe('stockReport', () => {
  it('puts low stock first with how long it lasts', () => {
    const r = stockReport(ledger(), NOW);
    expect(r.map((x) => [x.listing.id, x.status])).toEqual([['soda', 'low'], ['sam', 'ok']]);
    expect(r[0].perDay).toBeCloseTo(2);
    expect(Math.floor(r[0].daysLeft!)).toBe(2);
  });
});

describe('withPending', () => {
  it('adds unsynced sales and restocks on top of the server copy, once', () => {
    const l = withPending(ledger(), [
      { clientId: 'p1', listingId: 'sam', type: 'SALE', quantity: 5, unitPriceCents: 50, at: iso(0, 14) },
      { clientId: 'p2', listingId: 'soda', type: 'RESTOCK', quantity: 24, unitCostCents: 60, at: iso(0, 14) },
      { clientId: 'e1', listingId: 'sam', type: 'SALE', quantity: 10, unitPriceCents: 50, at: iso(0, 10) },
    ]);
    expect(l.listings.find((x) => x.id === 'sam')!.stockQty).toBe(35);
    expect(l.listings.find((x) => x.id === 'soda')).toMatchObject({ stockQty: 28, costCents: 60 });
    expect(summarize(l, 'today', NOW).profitCents).toBe(280 + 5 * 25);
  });
});

describe('factSheet and unknownAmounts', () => {
  it('gives the model only calculated numbers and catches invented ones', () => {
    const facts = factSheet(ledger(), NOW);
    expect(facts).toContain('Today: 2 sales, 12 units, revenue $6.60');
    expect(facts).toContain('Soda: 4 left, LOW');
    expect(unknownAmounts('You made $2.80 profit today on $6.60 of sales.', facts)).toEqual([]);
    expect(unknownAmounts('You made $9.99 today.', facts)).toEqual(['$9.99']);
  });
});

import { plainAnswer } from './numbers';
describe('plainAnswer', () => {
  it('answers stock and profit questions with no AI', () => {
    expect(plainAnswer('what is running low?', ledger(), NOW)).toContain('Soda: 4 left');
    expect(plainAnswer('how much profit today', ledger(), NOW)).toContain('your profit is $2.80');
    expect(plainAnswer('profit this week', ledger(), NOW)).toContain('Airtime');
  });
});

describe('stock pace', () => {
  it('flags an item that will run out within 3 days even above its warning level', () => {
    const l = ledger();
    l.entries.push({ id: 'big', source: 'STALL', type: 'SALE', listingId: 'sam', title: 'Samosa', quantity: 100, unitPriceCents: 50, unitCostCents: 25, feesCents: 0, note: '', at: iso(1) });
    expect(stockReport(l, NOW).find((r) => r.listing.id === 'sam')!.status).toBe('low');
  });
});
