import { BadRequestException } from '@nestjs/common';

/**
 * The stall book: the owner's in-person sales and restocks.
 * Entries are written on the device first (often with no connection) and synced later, so every rule
 * here assumes an entry may arrive twice, late, or out of order.
 */

export const MAX_SYNC_BATCH = 200;
/** How far back an entry may be dated. Older ones are refused so a broken device clock cannot rewrite history. */
export const MAX_ENTRY_AGE_MS = 60 * 24 * 60 * 60 * 1000;
/** Device clocks drift; allow a little time in the future. */
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
/** How much history the ledger endpoint returns to the device. */
export const LEDGER_DAYS = 90;
export const MAX_LEDGER_ENTRIES = 2000;

export type EntryType = 'SALE' | 'RESTOCK';

export interface IncomingEntry {
  clientId?: unknown;
  listingId?: unknown;
  type?: unknown;
  quantity?: unknown;
  unitPriceCents?: unknown;
  unitCostCents?: unknown;
  note?: unknown;
  at?: unknown;
}

export interface CleanEntry {
  clientId: string;
  listingId: string;
  type: EntryType;
  quantity: number;
  unitPriceCents: number | null;
  unitCostCents: number | null;
  note: string;
  at: Date;
}

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

function intIn(raw: unknown, min: number, max: number): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null;
}

/** Checks one entry. Returns the clean entry, or a plain reason the device can show the owner. */
export function cleanEntry(raw: IncomingEntry, now = Date.now()): { entry: CleanEntry } | { reason: string } {
  if (!raw || typeof raw !== 'object') return { reason: 'Not an entry.' };
  if (typeof raw.clientId !== 'string' || !CLIENT_ID.test(raw.clientId)) return { reason: 'Missing or invalid entry id.' };
  if (typeof raw.listingId !== 'string' || raw.listingId.length < 1 || raw.listingId.length > 64) return { reason: 'Missing listing.' };
  if (raw.type !== 'SALE' && raw.type !== 'RESTOCK') return { reason: 'Type must be SALE or RESTOCK.' };
  const quantity = intIn(raw.quantity, 1, 10000);
  if (quantity === null) return { reason: 'Quantity must be a whole number from 1 to 10000.' };

  let unitPriceCents: number | null = null;
  if (raw.type === 'SALE') {
    unitPriceCents = intIn(raw.unitPriceCents, 0, 100000);
    if (unitPriceCents === null) return { reason: 'Sale price must be between $0 and $1000 per unit.' };
  }
  let unitCostCents: number | null = null;
  if (raw.unitCostCents !== undefined && raw.unitCostCents !== null) {
    unitCostCents = intIn(raw.unitCostCents, 0, 100000);
    if (unitCostCents === null) return { reason: 'Cost must be between $0 and $1000 per unit.' };
  }

  const at = typeof raw.at === 'string' || typeof raw.at === 'number' ? new Date(raw.at) : null;
  if (!at || Number.isNaN(at.getTime())) return { reason: 'Missing or invalid time.' };
  if (at.getTime() > now + MAX_CLOCK_SKEW_MS) return { reason: 'This entry is dated in the future. Check the device clock.' };
  if (at.getTime() < now - MAX_ENTRY_AGE_MS) return { reason: 'This entry is more than 60 days old.' };

  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 140) : '';
  return { entry: { clientId: raw.clientId, listingId: raw.listingId, type: raw.type, quantity, unitPriceCents, unitCostCents, note, at } };
}

export function assertBatch(raw: unknown): IncomingEntry[] {
  if (!Array.isArray(raw)) throw new BadRequestException('Send { "entries": [...] }.');
  if (raw.length > MAX_SYNC_BATCH) throw new BadRequestException(`Send at most ${MAX_SYNC_BATCH} entries at a time.`);
  return raw as IncomingEntry[];
}

/** New stock after an entry, for a listing whose current stock is `stockQty` (null = not tracked). */
export function stockAfter(stockQty: number | null, type: EntryType, quantity: number): number | null {
  if (type === 'RESTOCK') return (stockQty ?? 0) + quantity; // a first restock starts tracking
  return stockQty === null ? null : stockQty - quantity; // may go below zero: the owner sold what the count missed
}

/** Optional listing numbers: undefined = leave alone, null or '' = clear, otherwise a whole number in range. */
export function optionalInt(raw: unknown, label: string, min: number, max: number): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const v = intIn(raw, min, max);
  if (v === null) throw new BadRequestException(`${label} must be a whole number from ${min} to ${max}.`);
  return v;
}

/** Splits `total` across `weights` in whole cents, so the parts always add up exactly. */
export function splitCents(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!total || !sum) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}
