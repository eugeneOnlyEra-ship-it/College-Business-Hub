import type { Ledger, LedgerEntry, PendingEntry, StallListing } from './types';

/**
 * All the arithmetic for Stall mode lives here, in plain code.
 * The AI never adds up money: it only puts these numbers into words.
 */

export const DEFAULT_LOW_STOCK = 5;
/** Also warn when an item will run out in fewer than this many days at its recent pace. */
export const LOW_DAYS = 3;
const DAY = 24 * 60 * 60 * 1000;

export const money = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** The server copy plus what this device recorded since: what the owner actually has right now. */
export function withPending(ledger: Ledger, pending: PendingEntry[]): Ledger {
  if (!pending.length) return ledger;
  const listings = ledger.listings.map((l) => ({ ...l }));
  const byId = new Map(listings.map((l) => [l.id, l]));
  const saved = new Set(ledger.entries.map((e) => e.id));
  const extra: LedgerEntry[] = [];
  for (const p of [...pending].sort((a, b) => a.at.localeCompare(b.at))) {
    if (saved.has(p.clientId)) continue; // already in the server copy
    const l = byId.get(p.listingId);
    if (!l) continue;
    if (p.type === 'RESTOCK') {
      l.stockQty = (l.stockQty ?? 0) + p.quantity;
      if (p.unitCostCents !== undefined) l.costCents = p.unitCostCents;
    } else if (l.stockQty !== null) {
      l.stockQty -= p.quantity;
    }
    extra.push({
      id: p.clientId,
      source: 'STALL',
      type: p.type,
      listingId: p.listingId,
      title: l.title,
      quantity: p.quantity,
      unitPriceCents: p.unitPriceCents ?? null,
      unitCostCents: p.unitCostCents ?? (p.type === 'SALE' ? l.costCents : null),
      feesCents: 0,
      note: p.note ?? '',
      at: p.at,
    });
  }
  return { ...ledger, listings, entries: [...extra, ...ledger.entries].sort((a, b) => b.at.localeCompare(a.at)) };
}

export type Period = 'today' | 'yesterday' | 'week' | 'month';

export function periodStart(period: Period, now = new Date()): { from: Date; to: Date; label: string } {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (period === 'today') return { from: midnight, to: now, label: 'today' };
  if (period === 'yesterday') return { from: new Date(midnight.getTime() - DAY), to: midnight, label: 'yesterday' };
  if (period === 'week') return { from: new Date(midnight.getTime() - 6 * DAY), to: now, label: 'the last 7 days' };
  return { from: new Date(midnight.getTime() - 29 * DAY), to: now, label: 'the last 30 days' };
}

export interface ItemSummary {
  listingId: string;
  title: string;
  units: number;
  revenueCents: number;
  costCents: number;
  profitCents: number;
  /** Units sold whose cost is unknown: their profit is left out rather than guessed. */
  unitsWithoutCost: number;
}

export interface Summary {
  label: string;
  sales: number;
  units: number;
  revenueCents: number;
  costCents: number;
  feesCents: number;
  /** Revenue minus known costs minus fees. Lines with unknown cost count their revenue and fees only. */
  profitCents: number;
  cashCents: number;
  onlineCents: number;
  items: ItemSummary[];
  missingCost: string[];
}

export function summarize(ledger: Ledger, period: Period, now = new Date()): Summary {
  const { from, to, label } = periodStart(period, now);
  const items = new Map<string, ItemSummary>();
  const s: Summary = { label, sales: 0, units: 0, revenueCents: 0, costCents: 0, feesCents: 0, profitCents: 0, cashCents: 0, onlineCents: 0, items: [], missingCost: [] };
  for (const e of ledger.entries) {
    if (e.type !== 'SALE') continue;
    const at = new Date(e.at);
    if (at < from || at >= to) continue;
    const revenue = (e.unitPriceCents ?? 0) * e.quantity;
    const cost = e.unitCostCents === null ? 0 : e.unitCostCents * e.quantity;
    s.sales += 1;
    s.units += e.quantity;
    s.revenueCents += revenue;
    s.costCents += cost;
    s.feesCents += e.feesCents;
    if (e.source === 'PAYPAL') s.onlineCents += revenue;
    else s.cashCents += revenue;
    const it = items.get(e.listingId) ?? { listingId: e.listingId, title: e.title, units: 0, revenueCents: 0, costCents: 0, profitCents: 0, unitsWithoutCost: 0 };
    it.units += e.quantity;
    it.revenueCents += revenue;
    it.costCents += cost;
    it.profitCents += revenue - cost - e.feesCents;
    if (e.unitCostCents === null) it.unitsWithoutCost += e.quantity;
    items.set(e.listingId, it);
  }
  s.profitCents = s.revenueCents - s.costCents - s.feesCents;
  s.items = [...items.values()].sort((a, b) => b.profitCents - a.profitCents);
  s.missingCost = s.items.filter((i) => i.unitsWithoutCost > 0).map((i) => i.title);
  return s;
}

export interface StockLine {
  listing: StallListing;
  stock: number;
  status: 'out' | 'low' | 'ok';
  /** Average units sold per day over the last 7 days. */
  perDay: number;
  /** Roughly how many days the stock lasts at that pace. Null when nothing sold lately. */
  daysLeft: number | null;
}

/** Stock for every counted listing, worst first. */
export function stockReport(ledger: Ledger, now = new Date()): StockLine[] {
  const weekAgo = now.getTime() - 7 * DAY;
  const sold = new Map<string, number>();
  for (const e of ledger.entries) {
    if (e.type === 'SALE' && new Date(e.at).getTime() >= weekAgo) sold.set(e.listingId, (sold.get(e.listingId) ?? 0) + e.quantity);
  }
  const rank = { out: 0, low: 1, ok: 2 } as const;
  return ledger.listings
    .filter((l) => l.stockQty !== null && l.active)
    .map((l) => {
      const stock = l.stockQty as number;
      const perDay = (sold.get(l.id) ?? 0) / 7;
      const lowAt = l.lowStockAt ?? DEFAULT_LOW_STOCK;
      const daysLeft = perDay > 0 ? Math.max(0, stock) / perDay : null;
      // Low when under the owner's warning level, or when it will run out within LOW_DAYS at the current pace.
      const status: StockLine['status'] = stock <= 0 ? 'out' : stock <= lowAt || (daysLeft !== null && daysLeft < LOW_DAYS) ? 'low' : 'ok';
      return { listing: l, stock, status, perDay, daysLeft };
    })
    .sort((a, b) => rank[a.status] - rank[b.status] || (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity));
}

/**
 * The facts the model is allowed to use, as short plain lines. Small on-device models do much better with a
 * compact, already-calculated sheet than with raw rows, and it keeps the prompt well under the on-device limit.
 */
export function factSheet(ledger: Ledger, now = new Date()): string {
  const lines: string[] = [`Business: ${ledger.business.name} (${ledger.business.category}). Currency: US dollars.`];
  for (const p of ['today', 'yesterday', 'week', 'month'] as const) {
    const s = summarize(ledger, p, now);
    lines.push(
      `${cap(s.label)}: ${s.sales} sales, ${s.units} units, revenue ${money(s.revenueCents)}, costs ${money(s.costCents)}, fees ${money(s.feesCents)}, profit ${money(s.profitCents)} (cash ${money(s.cashCents)}, online ${money(s.onlineCents)}).`,
    );
    if (p === 'week' || p === 'today') {
      const top = s.items.slice(0, 5).map((i) => `${i.title} ${i.units} sold, profit ${money(i.profitCents)}`);
      if (top.length) lines.push(`  By item ${s.label}: ${top.join('; ')}.`);
    }
    if (p === 'month' && s.missingCost.length) lines.push(`  Cost unknown (profit for these counts no cost): ${s.missingCost.join(', ')}.`);
  }
  const stock = stockReport(ledger, now);
  if (stock.length) {
    lines.push('Stock now:');
    for (const st of stock) {
      const pace = st.daysLeft === null ? 'no sales in 7 days' : `sells about ${st.perDay.toFixed(1)} a day, lasts about ${Math.floor(st.daysLeft)} days`;
      lines.push(`  ${st.listing.title}: ${st.stock} left, ${st.status === 'out' ? 'OUT OF STOCK' : st.status === 'low' ? 'LOW' : 'ok'}, ${pace}.`);
    }
  }
  const notCounted = ledger.listings.filter((l) => l.active && l.stockQty === null && l.kind === 'PRODUCT').map((l) => l.title);
  if (notCounted.length) lines.push(`Stock not counted for: ${notCounted.join(', ')}.`);
  const prices = ledger.listings.filter((l) => l.active).map((l) => `${l.title} ${money(l.priceCents)}${l.costCents !== null ? ` (costs ${money(l.costCents)})` : ''}`);
  lines.push(`Prices: ${prices.join('; ')}.`);
  return lines.join('\n');
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Every dollar amount in the model's answer must appear in the fact sheet (or be a simple sum the owner can see).
 * Returns the amounts that do not, so the screen can warn instead of showing a made-up number as fact.
 */
export function unknownAmounts(answer: string, facts: string): string[] {
  const norm = (m: string) => (Math.round(parseFloat(m.replace(/[$,]/g, '')) * 100) / 100).toFixed(2);
  const known = new Set((facts.match(/\$\d[\d,]*(?:\.\d+)?/g) ?? []).map(norm));
  const found = answer.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? [];
  return [...new Set(found.map((m) => m.replace(/\s/g, '')))].filter((m) => !known.has(norm(m)));
}

/** A short id made on the device, so the server can recognise the same entry if it is sent twice. */
export function newClientId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'st_' + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

/**
 * The answer with no AI at all: used when there is no on-device model and no connection.
 * It picks the period and topic from simple words, and always tells the truth from the numbers.
 */
export function plainAnswer(question: string, ledger: Ledger, now = new Date()): string {
  const q = question.toLowerCase();
  if (/\b(stock|low|left|run(ning)? out|restock|inventory|finish)/.test(q)) {
    const st = stockReport(ledger, now).filter((s) => s.status !== 'ok');
    if (!st.length) return stockReport(ledger, now).length ? 'Nothing is running low right now.' : 'No stock is being counted yet. Add stock numbers on My business.';
    return st
      .map((s) => `${s.listing.title}: ${s.stock <= 0 ? 'out of stock' : `${s.stock} left`}${s.daysLeft !== null && s.stock > 0 ? `, about ${Math.floor(s.daysLeft)} days at this pace` : ''}.`)
      .join(' ');
  }
  const period: Period = /yesterday/.test(q) ? 'yesterday' : /\b(week|7 days)\b/.test(q) ? 'week' : /\b(month|30 days)\b/.test(q) ? 'month' : 'today';
  const s = summarize(ledger, period, now);
  if (!s.sales) return `No sales recorded ${s.label}.`;
  const best = s.items[0];
  return `${cap(s.label)}: ${s.units} units sold for ${money(s.revenueCents)}. After costs (${money(s.costCents)}) and fees (${money(s.feesCents)}) your profit is ${money(s.profitCents)}.${best ? ` Best earner: ${best.title} (${money(best.profitCents)}).` : ''}${s.missingCost.length ? ` No cost recorded for ${s.missingCost.join(', ')}, so their profit counts no cost.` : ''}`;
}
