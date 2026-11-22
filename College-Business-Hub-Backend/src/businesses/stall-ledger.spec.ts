import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
vi.mock('../paypal/paypal.service.js', () => ({ PaypalService: class {} }));
import { BusinessesService } from './businesses.service.js';
import { cleanEntry, splitCents, stockAfter } from './stall-ledger.js';

const NOW = Date.parse('2026-11-22T10:00:00Z');
const base = { clientId: 'abcd1234', listingId: 'l1', type: 'SALE', quantity: 2, unitPriceCents: 150, at: '2026-11-22T09:00:00Z' };

describe('cleanEntry', () => {
  it('accepts a normal stall sale', () => {
    const r = cleanEntry(base, NOW);
    expect('entry' in r && r.entry).toMatchObject({ type: 'SALE', quantity: 2, unitPriceCents: 150, unitCostCents: null });
  });
  it('refuses bad ids, quantities, prices and clocks', () => {
    expect(cleanEntry({ ...base, clientId: 'x' }, NOW)).toHaveProperty('reason');
    expect(cleanEntry({ ...base, quantity: 0 }, NOW)).toHaveProperty('reason');
    expect(cleanEntry({ ...base, quantity: 1.5 }, NOW)).toHaveProperty('reason');
    expect(cleanEntry({ ...base, unitPriceCents: undefined }, NOW)).toHaveProperty('reason');
    expect(cleanEntry({ ...base, at: '2026-11-23T10:00:00Z' }, NOW)).toHaveProperty('reason');
    expect(cleanEntry({ ...base, at: '2026-08-01T10:00:00Z' }, NOW)).toHaveProperty('reason');
  });
  it('lets a restock skip the price', () => {
    const r = cleanEntry({ ...base, type: 'RESTOCK', unitPriceCents: undefined, unitCostCents: 80 }, NOW);
    expect('entry' in r && r.entry).toMatchObject({ type: 'RESTOCK', unitPriceCents: null, unitCostCents: 80 });
  });
});

describe('stockAfter and splitCents', () => {
  it('moves stock and starts tracking on the first restock', () => {
    expect(stockAfter(10, 'SALE', 3)).toBe(7);
    expect(stockAfter(null, 'SALE', 3)).toBeNull();
    expect(stockAfter(null, 'RESTOCK', 12)).toBe(12);
    expect(stockAfter(1, 'SALE', 3)).toBe(-2);
  });
  it('splits fees into whole cents that add up', () => {
    const parts = splitCents(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(splitCents(0, [5, 5])).toEqual([0, 0]);
  });
});

function makeSvc(opts: { known?: { clientId: string; businessId: string }[]; stockQty?: number | null } = {}) {
  const listing = { id: 'l1', businessId: 'b1', title: 'Samosa', kind: 'PRODUCT', unit: null, active: true, priceCents: 150, costCents: 60, stockQty: opts.stockQty === undefined ? 20 : opts.stockQty, lowStockAt: null, createdAt: new Date() };
  const prisma = {
    business: { findUnique: vi.fn().mockResolvedValue({ id: 'b1', name: 'Snacks', category: 'food', closedAt: null, owner: { email: 'amina@campus.test' } }) },
    listing: { findMany: vi.fn().mockResolvedValue([listing]), update: vi.fn((a) => ({ op: 'listing.update', ...a })) },
    ledgerEntry: {
      findMany: vi.fn().mockResolvedValueOnce(opts.known ?? []).mockResolvedValue([]),
      create: vi.fn((a) => ({ op: 'ledger.create', ...a })),
    },
    orderItem: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockResolvedValue([]),
  };
  return { prisma, svc: new BusinessesService(prisma as never, {} as never) };
}

describe('BusinessesService.syncLedger', () => {
  const recent = new Date(Date.now() - 60_000).toISOString();
  it('saves a new sale with the cost at the time and takes it out of stock', async () => {
    const { svc, prisma } = makeSvc();
    const r = await svc.syncLedger('b1', 'amina@campus.test', [{ ...base, at: recent }]);
    expect(r.accepted).toEqual(['abcd1234']);
    const ops = prisma.$transaction.mock.calls[0][0];
    expect(ops[0].data).toMatchObject({ clientId: 'abcd1234', businessId: 'b1', unitCostCents: 60, quantity: 2 });
    expect(ops[1].data).toEqual({ stockQty: { decrement: 2 } });
  });
  it('does not count an entry twice when the device retries', async () => {
    const { svc, prisma } = makeSvc({ known: [{ clientId: 'abcd1234', businessId: 'b1' }] });
    const r = await svc.syncLedger('b1', 'amina@campus.test', [{ ...base, at: recent }, { ...base, at: recent }]);
    expect(r.accepted).toEqual(['abcd1234', 'abcd1234']);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rejects listings from other businesses so the device stops retrying', async () => {
    const { svc } = makeSvc();
    const r = await svc.syncLedger('b1', 'amina@campus.test', [{ ...base, listingId: 'other', at: recent }]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]).toMatchObject({ clientId: 'abcd1234' });
  });
  it('a first restock starts counting stock and updates the cost', async () => {
    const { svc, prisma } = makeSvc({ stockQty: null });
    await svc.syncLedger('b1', 'amina@campus.test', [{ ...base, type: 'RESTOCK', unitPriceCents: undefined, unitCostCents: 70, quantity: 30, at: recent }]);
    expect(prisma.$transaction.mock.calls[0][0][1].data).toEqual({ stockQty: 30, costCents: 70 });
  });
  it("refuses someone else's business", async () => {
    await expect(makeSvc().svc.syncLedger('b1', 'x@y.test', [])).rejects.toBeInstanceOf(ForbiddenException);
  });
});
