import type { SaleDraft } from './ai';
import type { StallListing } from './types';

/**
 * The no-AI fallback for reading a note like "sold 3 samosas at 50c" or "restocked 24 soda".
 * Used when there is no on-device model and no connection, so logging a sale never depends on AI.
 */
export function quickParse(text: string, listings: StallListing[]): SaleDraft | null {
  const t = text.toLowerCase();
  const restock = /\b(restock(ed)?|bought|got|received|added|buy|delivered|new stock)\b/.test(t);

  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const stem = (w: string) => w.replace(/(es|s)$/, '');
  const noteWords = new Set(words(t).map(stem));
  let best: { l: StallListing; score: number } | null = null;
  for (const l of listings) {
    const score = words(l.title).map(stem).filter((w) => noteWords.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { l, score };
  }
  if (!best) return null;

  // Money: "$1.50", "1.50 each", "50c", "at 2".
  const moneyMatch = t.match(/\$\s?(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s?(?:c|cents)\b|\bat\s(\d+(?:\.\d{1,2})?)|(\d+\.\d{1,2})\s?(?:each|per)/);
  let unit: number | undefined;
  let moneyText = '';
  if (moneyMatch) {
    moneyText = moneyMatch[0];
    if (moneyMatch[2]) unit = Math.round(parseFloat(moneyMatch[2]));
    else unit = Math.round(parseFloat(moneyMatch[1] ?? moneyMatch[3] ?? moneyMatch[4]) * 100);
  }
  // Quantity: the first whole number that is not part of the price.
  const qtyMatch = t.replace(moneyText, ' ').match(/\b(\d{1,5})\b/);
  const quantity = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
  if (quantity < 1) return null;

  return restock
    ? { type: 'RESTOCK', listingId: best.l.id, quantity, unitCostCents: unit }
    : { type: 'SALE', listingId: best.l.id, quantity, unitPriceCents: unit };
}
