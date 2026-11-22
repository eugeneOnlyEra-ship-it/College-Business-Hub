-- AlterTable
ALTER TABLE "Listing" ADD COLUMN "stockQty" INTEGER;
ALTER TABLE "Listing" ADD COLUMN "lowStockAt" INTEGER;
ALTER TABLE "Listing" ADD COLUMN "costCents" INTEGER;

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER,
    "unitCostCents" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "at" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerEntry_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LedgerEntry_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_clientId_key" ON "LedgerEntry"("clientId");

-- CreateIndex
CREATE INDEX "LedgerEntry_businessId_at_idx" ON "LedgerEntry"("businessId", "at");
