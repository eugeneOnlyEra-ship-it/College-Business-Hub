import 'dotenv/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient, type ListingKind } from './generated/prisma/client.js';

/**
 * Demo data. Safe to run repeatedly (upserts / skips existing rows).
 *
 * Two sellers are linked to PayPal SANDBOX merchant accounts that were onboarded to the platform.
 * If you use your own PayPal sandbox app, onboard your own sellers (POST /paypal/onboard) and
 * set SEED_PRINT_MERCHANT_ID / SEED_SALON_MERCHANT_ID in .env before seeding.
 * The transport business is deliberately NOT onboarded: the policy engine should block paying it.
 */
const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? 'file:./dev.db' });
const prisma = new PrismaClient({ adapter });

const PRINT_MERCHANT = process.env.SEED_PRINT_MERCHANT_ID ?? 'NR94ASH7KHULQ';
const SALON_MERCHANT = process.env.SEED_SALON_MERCHANT_ID ?? 'MTP98HKC3YJDC';

interface SeedListing {
  title: string;
  description: string;
  kind: ListingKind;
  priceCents: number;
  unit: string;
  stockQty?: number | null;
  lowStockAt?: number | null;
  costCents?: number | null;
}

async function seedBusiness(opts: {
  ownerEmail: string;
  ownerName: string;
  trackingId: string;
  name: string;
  category: string;
  description: string;
  merchantId: string | null;
  listings: SeedListing[];
}) {
  const owner = await prisma.user.upsert({
    where: { email: opts.ownerEmail },
    update: {},
    create: { email: opts.ownerEmail, name: opts.ownerName },
  });

  const business = await prisma.business.upsert({
    where: { paypalTrackingId: opts.trackingId },
    update: {
      paypalMerchantId: opts.merchantId,
      onboarding: opts.merchantId ? 'READY' : 'NOT_STARTED',
    },
    create: {
      ownerId: owner.id,
      name: opts.name,
      category: opts.category,
      description: opts.description,
      paypalTrackingId: opts.trackingId,
      paypalMerchantId: opts.merchantId,
      onboarding: opts.merchantId ? 'READY' : 'NOT_STARTED',
    },
  });

  for (const l of opts.listings) {
    const exists = await prisma.listing.findFirst({
      where: { businessId: business.id, title: l.title },
    });
    if (!exists) {
      await prisma.listing.create({ data: { ...l, businessId: business.id } });
    }
  }
  return business;
}

async function main() {
  await prisma.user.upsert({
    where: { email: 'student@example.com' },
    update: {},
    create: { email: 'student@example.com', name: 'Demo Student' },
  });

  await seedBusiness({
    ownerEmail: 'print.owner@example.com',
    ownerName: 'Print Hub Owner',
    trackingId: 'seed-print-hub',
    name: 'Campus Print Hub',
    category: 'printing',
    description: 'Fast, cheap printing and binding for assignments.',
    merchantId: PRINT_MERCHANT,
    listings: [
      { title: 'Black & white printing (40 pages)', description: 'A4, single sided, black and white printing.', kind: 'SERVICE', priceCents: 1000, unit: 'per 40 pages' },
      { title: 'Colour printing (10 pages)', description: 'A4 full colour printing.', kind: 'SERVICE', priceCents: 800, unit: 'per 10 pages' },
      { title: 'Spiral binding', description: 'Spiral bind a document up to 100 pages.', kind: 'SERVICE', priceCents: 500, unit: 'per document' },
    ],
  });

  await seedBusiness({
    ownerEmail: 'salon.owner@example.com',
    ownerName: 'Salon Owner',
    trackingId: 'seed-fresh-cuts',
    name: 'Fresh Cuts Salon',
    category: 'salon',
    description: 'Student-run barber and hair salon, appointments on weekends.',
    merchantId: SALON_MERCHANT,
    listings: [
      { title: 'Haircut', description: 'Standard haircut and style.', kind: 'SERVICE', priceCents: 1500, unit: 'per haircut' },
      { title: 'Beard trim', description: 'Beard shaping and trim.', kind: 'SERVICE', priceCents: 700, unit: 'per trim' },
    ],
  });

  await seedBusiness({
    ownerEmail: 'rides.owner@example.com',
    ownerName: 'Rides Owner',
    trackingId: 'seed-campus-rides',
    name: 'Campus Rides',
    category: 'transport',
    description: 'Shared rides from campus to town. (Not yet onboarded to PayPal.)',
    merchantId: null,
    listings: [
      { title: 'Ride to town centre', description: 'Shared ride, leaves from the main gate.', kind: 'SERVICE', priceCents: 800, unit: 'per seat' },
    ],
  });

  await seedStall();

  const [users, businesses, listings] = await Promise.all([
    prisma.user.count(),
    prisma.business.count(),
    prisma.listing.count(),
  ]);
  console.log(`Seed complete: ${users} users, ${businesses} businesses, ${listings} listings.`);
}

/**
 * The demo seller's own stall, with counted stock, costs and two weeks of in-person sales,
 * so "Stall mode" (offline profit and stock answers) has something to show straight away.
 * Shares the print shop's sandbox PayPal account so it can also be paid online.
 */
async function seedStall() {
  const stall = await seedBusiness({
    ownerEmail: 'demo-owner@campus.test',
    ownerName: 'Demo Owner',
    trackingId: 'seed-tuck-shop',
    name: 'Hostel Tuck Shop',
    category: 'snacks',
    description: 'Snacks and drinks from room 14, open late during exams.',
    merchantId: PRINT_MERCHANT,
    listings: [
      { title: 'Samosa', description: 'Beef or vegetable, made fresh each morning.', kind: 'PRODUCT', priceCents: 50, unit: 'each', stockQty: 40, lowStockAt: 15, costCents: 25 },
      { title: 'Soft drink (500 ml)', description: 'Cold Coke, Fanta or Sprite.', kind: 'PRODUCT', priceCents: 80, unit: 'per bottle', stockQty: 6, lowStockAt: 10, costCents: 55 },
      { title: 'Instant noodles', description: 'Chicken or beef flavour.', kind: 'PRODUCT', priceCents: 70, unit: 'per pack', stockQty: 25, lowStockAt: 8, costCents: 45 },
      { title: 'Airtime top-up', description: 'Any network, sent to your number.', kind: 'SERVICE', priceCents: 100, unit: 'per top-up', costCents: 95 },
    ],
  });
  const listings = await prisma.listing.findMany({ where: { businessId: stall.id } });
  const byTitle = new Map(listings.map((l) => [l.title, l]));
  // [days ago, listing, quantity] — a believable two weeks: samosas every day, drinks running down.
  const history: [number, string, number][] = [];
  for (let d = 14; d >= 1; d--) {
    history.push([d, 'Samosa', 8 + ((d * 7) % 9)]);
    if (d % 2 === 0) history.push([d, 'Soft drink (500 ml)', 3 + (d % 4)]);
    if (d % 3 === 0) history.push([d, 'Instant noodles', 2 + (d % 3)]);
    if (d % 4 === 1) history.push([d, 'Airtime top-up', 2]);
  }
  for (const [daysAgo, title, quantity] of history) {
    const l = byTitle.get(title);
    if (!l) continue;
    const clientId = `seed-${daysAgo}-${l.id.slice(-6)}`;
    const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    at.setHours(12 + (daysAgo % 8), 15, 0, 0);
    await prisma.ledgerEntry.upsert({
      where: { clientId },
      update: {},
      create: { clientId, businessId: stall.id, listingId: l.id, type: 'SALE', quantity, unitPriceCents: l.priceCents, unitCostCents: l.costCents, note: 'cash', at },
    });
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
