/** Shapes shared by Stall mode. They mirror GET /businesses/:id/ledger on the backend. */

export interface StallListing {
  id: string;
  title: string;
  kind: 'PRODUCT' | 'SERVICE';
  unit: string | null;
  active: boolean;
  priceCents: number;
  /** What one unit costs the owner. Null = unknown, so profit for it cannot be worked out. */
  costCents: number | null;
  /** Units on hand. Null = not counted. */
  stockQty: number | null;
  lowStockAt: number | null;
}

export interface LedgerEntry {
  /** For stall entries this is the clientId made on the device. */
  id: string;
  source: 'STALL' | 'PAYPAL';
  type: 'SALE' | 'RESTOCK';
  listingId: string;
  title: string;
  quantity: number;
  unitPriceCents: number | null;
  unitCostCents: number | null;
  /** Platform and PayPal fees for this line. Zero for cash sales. */
  feesCents: number;
  note: string;
  at: string;
}

export interface Ledger {
  business: { id: string; name: string; category: string; closed: boolean };
  generatedAt: string;
  listings: StallListing[];
  entries: LedgerEntry[];
}

/** Something the owner recorded on this device that the server has not saved yet. */
export interface PendingEntry {
  clientId: string;
  listingId: string;
  type: 'SALE' | 'RESTOCK';
  quantity: number;
  unitPriceCents?: number;
  unitCostCents?: number;
  note?: string;
  at: string;
}

export interface SyncResult {
  accepted: string[];
  rejected: { clientId: string; reason: string }[];
  ledger: Ledger;
}
