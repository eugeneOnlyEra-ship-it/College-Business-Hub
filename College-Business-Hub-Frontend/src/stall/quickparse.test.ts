import { describe, expect, it } from 'vitest';
import { quickParse } from './quickparse';
import type { StallListing } from './types';

const L = (id: string, title: string): StallListing => ({ id, title, kind: 'PRODUCT', unit: null, active: true, priceCents: 50, costCents: 25, stockQty: 10, lowStockAt: null });
const listings = [L('sam', 'Samosa'), L('soda', 'Soft drink (500 ml)'), L('nood', 'Instant noodles')];

describe('quickParse (no AI)', () => {
  it('reads a simple sale', () => {
    expect(quickParse('sold 3 samosas', listings)).toEqual({ type: 'SALE', listingId: 'sam', quantity: 3, unitPriceCents: undefined });
  });
  it('reads prices in dollars and cents', () => {
    expect(quickParse('2 noodles at 1.20', listings)).toMatchObject({ listingId: 'nood', quantity: 2, unitPriceCents: 120 });
    expect(quickParse('sold 4 samosa 45c', listings)).toMatchObject({ quantity: 4, unitPriceCents: 45 });
  });
  it('knows a restock', () => {
    expect(quickParse('bought 24 soft drinks $0.55 each', listings)).toEqual({ type: 'RESTOCK', listingId: 'soda', quantity: 24, unitCostCents: 55 });
  });
  it('gives up rather than guessing an item', () => {
    expect(quickParse('sold 2 haircuts', listings)).toBeNull();
  });
});
