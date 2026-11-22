import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PaypalService } from '../paypal/paypal.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateBusinessDto, CreateListingDto, ListingImageDto, UpdateBusinessDto, UpdateListingDto } from './businesses.dto.js';
import { decodeBase64Image, imageUrlFor, MAX_IMAGE_BYTES, removeListingImage, saveListingImage } from './listing-images.js';
import {
  assertBatch,
  cleanEntry,
  LEDGER_DAYS,
  MAX_LEDGER_ENTRIES,
  optionalInt,
  splitCents,
  stockAfter,
  type CleanEntry,
} from './stall-ledger.js';

const MAX_BUSINESSES_PER_OWNER = 5;
const MAX_LISTINGS_PER_BUSINESS = 30;
// A PayPal approval link stays valid for about this long, so an unfinished checkout newer than this may still be paid.
const PAYMENT_WINDOW_MS = 3 * 60 * 60 * 1000;

function email(raw: unknown): string {
  const e = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new BadRequestException('Enter a valid email address.');
  }
  return e;
}

function text(raw: unknown, label: string, min: number, max: number): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length < min || s.length > max) {
    throw new BadRequestException(`${label} must be between ${min} and ${max} characters.`);
  }
  return s;
}

function optionalText(raw: unknown, label: string, max: number): string {
  if (raw === undefined || raw === null || raw === '') return '';
  return text(raw, label, 1, max);
}

@Injectable()
export class BusinessesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paypal: PaypalService,
  ) {}

  /**
   * DEMO ACCOUNTS: the owner's email identifies them. There is no password, so anyone who knows the
   * email can manage that business. Real sign-in is the first thing to add for production.
   */
  async create(dto: CreateBusinessDto) {
    const ownerEmail = email(dto?.ownerEmail);
    const name = text(dto.name, 'Business name', 2, 60);
    const category = text(dto.category, 'Category', 2, 30).toLowerCase();
    const description = optionalText(dto.description, 'Description', 200);
    const ownerName = optionalText(dto.ownerName, 'Your name', 60) || ownerEmail.split('@')[0];

    const owner = await this.prisma.user.upsert({
      where: { email: ownerEmail },
      update: {},
      create: { email: ownerEmail, name: ownerName },
    });
    const count = await this.prisma.business.count({ where: { ownerId: owner.id, closedAt: null } }); // closed ones do not count
    if (count >= MAX_BUSINESSES_PER_OWNER) {
      throw new BadRequestException(`One account can have at most ${MAX_BUSINESSES_PER_OWNER} businesses.`);
    }
    return this.prisma.business.create({
      data: {
        ownerId: owner.id,
        name,
        category,
        description,
        paypalTrackingId: `biz-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      },
    });
  }

  async listForOwner(rawEmail: string) {
    const owner = await this.prisma.user.findUnique({ where: { email: email(rawEmail) } });
    if (!owner) return [];
    const businesses = await this.prisma.business.findMany({
      where: { ownerId: owner.id },
      orderBy: { createdAt: 'asc' },
      include: { listings: { orderBy: { createdAt: 'asc' } } },
    });
    // Which of them have ever been ordered from (those can be closed but not deleted).
    const ordered = businesses.length
      ? await this.prisma.orderItem.groupBy({ by: ['businessId'], where: { businessId: { in: businesses.map((b) => b.id) } } })
      : [];
    const withOrders = new Set(ordered.map((o) => o.businessId));
    return businesses.map((b) => ({
      id: b.id,
      name: b.name,
      category: b.category,
      description: b.description,
      onboarding: b.onboarding,
      closed: b.closedAt !== null,
      hasOrders: withOrders.has(b.id),
      listings: b.listings.map((l) => ({
        id: l.id,
        title: l.title,
        description: l.description,
        priceCents: l.priceCents,
        kind: l.kind,
        unit: l.unit,
        active: l.active,
        imageUrl: imageUrlFor(l.id),
        stockQty: l.stockQty,
        lowStockAt: l.lowStockAt,
        costCents: l.costCents,
      })),
    }));
  }

  private async getOwned(id: string, rawEmail: unknown) {
    const ownerEmail = email(rawEmail);
    const business = await this.prisma.business.findUnique({ where: { id }, include: { owner: true } });
    if (!business) throw new NotFoundException('Business not found.');
    if (business.owner.email !== ownerEmail) {
      throw new ForbiddenException('This business belongs to a different account.');
    }
    return business;
  }

  /** A closed business is read-only until it is reopened. */
  private assertOpen(business: { closedAt: Date | null }) {
    if (business.closedAt) {
      throw new ConflictException('This business is closed. Reopen it on My business to make changes.');
    }
  }

  async addListing(id: string, dto: CreateListingDto) {
    const business = await this.getOwned(id, dto?.ownerEmail);
    this.assertOpen(business);
    const title = text(dto.title, 'Title', 2, 80);
    const description = optionalText(dto.description, 'Description', 200);
    const unit = optionalText(dto.unit, 'Unit', 30) || null;
    const kind = dto.kind === 'PRODUCT' ? 'PRODUCT' : 'SERVICE';
    if (!Number.isInteger(dto.priceCents) || dto.priceCents < 50 || dto.priceCents > 10000) {
      throw new BadRequestException('Price must be between $0.50 and $100.00.');
    }
    const stockQty = optionalInt(dto.stockQty, 'Stock', 0, 100000) ?? null;
    const lowStockAt = optionalInt(dto.lowStockAt, 'Low-stock warning', 0, 10000) ?? null;
    const costCents = optionalInt(dto.costCents, 'Cost', 0, 100000) ?? null;
    const count = await this.prisma.listing.count({ where: { businessId: business.id } });
    if (count >= MAX_LISTINGS_PER_BUSINESS) {
      throw new BadRequestException(`A business can have at most ${MAX_LISTINGS_PER_BUSINESS} listings.`);
    }
    return this.prisma.listing.create({
      data: { businessId: business.id, title, description, kind, priceCents: dto.priceCents, unit, stockQty, lowStockAt, costCents },
    });
  }

  /** Changes only the fields that were sent. Hiding a listing (active: false) keeps it for the owner but removes it from search and checkout. */
  async updateListing(id: string, listingId: string, dto: UpdateListingDto) {
    const business = await this.getOwned(id, dto?.ownerEmail);
    this.assertOpen(business);
    const listing = await this.prisma.listing.findFirst({ where: { id: listingId, businessId: business.id } });
    if (!listing) throw new NotFoundException('Listing not found.');
    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data.title = text(dto.title, 'Title', 2, 80);
    if (dto.description !== undefined) data.description = optionalText(dto.description, 'Description', 200);
    if (dto.unit !== undefined) data.unit = optionalText(dto.unit, 'Unit', 30) || null;
    if (dto.kind !== undefined) {
      if (dto.kind !== 'PRODUCT' && dto.kind !== 'SERVICE') throw new BadRequestException('Type must be a product or a service.');
      data.kind = dto.kind;
    }
    if (dto.priceCents !== undefined) {
      if (!Number.isInteger(dto.priceCents) || dto.priceCents < 50 || dto.priceCents > 10000) {
        throw new BadRequestException('Price must be between $0.50 and $100.00.');
      }
      data.priceCents = dto.priceCents;
    }
    if (dto.active !== undefined) {
      if (typeof dto.active !== 'boolean') throw new BadRequestException('Active must be true or false.');
      data.active = dto.active;
    }
    const stockQty = optionalInt(dto.stockQty, 'Stock', 0, 100000);
    if (stockQty !== undefined) data.stockQty = stockQty;
    const lowStockAt = optionalInt(dto.lowStockAt, 'Low-stock warning', 0, 10000);
    if (lowStockAt !== undefined) data.lowStockAt = lowStockAt;
    const costCents = optionalInt(dto.costCents, 'Cost', 0, 100000);
    if (costCents !== undefined) data.costCents = costCents;
    if (!Object.keys(data).length) throw new BadRequestException('Nothing to change.');
    const updated = await this.prisma.listing.update({ where: { id: listing.id }, data });
    return {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      kind: updated.kind,
      priceCents: updated.priceCents,
      unit: updated.unit,
      active: updated.active,
      stockQty: updated.stockQty,
      lowStockAt: updated.lowStockAt,
      costCents: updated.costCents,
    };
  }

  /** What this business has sold: totals and the most recent paid orders. Only paid (completed) orders count. */
  async sales(id: string, ownerEmail: unknown) {
    const business = await this.getOwned(id, ownerEmail);
    const where = { businessId: business.id, order: { status: 'COMPLETED' as const } };
    const [totals, recent] = await Promise.all([
      this.prisma.orderPayout.aggregate({
        where,
        _count: { _all: true },
        _sum: { grossCents: true, platformFeeCents: true, paypalFeeCents: true, netCents: true },
      }),
      this.prisma.orderPayout.findMany({
        where,
        orderBy: { order: { createdAt: 'desc' } },
        take: 20,
        include: {
          order: {
            select: {
              id: true,
              createdAt: true,
              buyer: { select: { name: true } },
              items: { where: { businessId: business.id }, select: { quantity: true, listing: { select: { title: true } } } },
            },
          },
        },
      }),
    ]);
    return {
      summary: {
        orders: totals._count._all,
        grossCents: totals._sum.grossCents ?? 0,
        platformFeeCents: totals._sum.platformFeeCents ?? 0,
        paypalFeeCents: totals._sum.paypalFeeCents ?? 0,
        netCents: totals._sum.netCents ?? 0,
      },
      recent: recent.map((p) => ({
        orderId: p.order.id,
        date: p.order.createdAt.toISOString(),
        buyerName: p.order.buyer.name,
        grossCents: p.grossCents,
        platformFeeCents: p.platformFeeCents,
        paypalFeeCents: p.paypalFeeCents,
        netCents: p.netCents,
        items: p.order.items.map((i) => ({ title: i.listing.title, quantity: i.quantity })),
      })),
    };
  }

  /** Lets the owner fix the name, category or description of their own business. */
  async updateBusiness(id: string, dto: UpdateBusinessDto) {
    const business = await this.getOwned(id, dto?.ownerEmail);
    this.assertOpen(business);
    const data: Record<string, string> = {};
    if (dto.name !== undefined) data.name = text(dto.name, 'Business name', 2, 60);
    if (dto.category !== undefined) data.category = text(dto.category, 'Category', 2, 30).toLowerCase();
    if (dto.description !== undefined) data.description = optionalText(dto.description, 'Description', 200);
    if (!Object.keys(data).length) throw new BadRequestException('Nothing to change.');
    const updated = await this.prisma.business.update({ where: { id: business.id }, data });
    return { id: updated.id, name: updated.name, category: updated.category, description: updated.description };
  }

  /** Saves (or replaces) the photo of one of the owner's listings. */
  async setListingImage(id: string, listingId: string, dto: ListingImageDto) {
    const business = await this.getOwned(id, dto?.ownerEmail);
    this.assertOpen(business);
    const listing = await this.prisma.listing.findFirst({ where: { id: listingId, businessId: business.id } });
    if (!listing) throw new NotFoundException('Listing not found.');
    const buf = decodeBase64Image(dto?.data);
    if (!buf) throw new BadRequestException('Choose a photo (JPG, PNG or WebP).');
    if (buf.length > MAX_IMAGE_BYTES) throw new BadRequestException('That photo is too big. Try a smaller one (up to 1 MB).');
    try {
      await saveListingImage(listing.id, buf);
    } catch {
      throw new BadRequestException('That file is not a JPG, PNG or WebP photo.');
    }
    return { imageUrl: imageUrlFor(listing.id) };
  }

  /**
   * Closes a business: shoppers can no longer see or order from it, but its order history, receipts and sales stay.
   * Refused while a buyer may still be in the middle of paying it.
   */
  async close(id: string, ownerEmail: unknown) {
    const business = await this.getOwned(id, ownerEmail);
    if (business.closedAt) return { id: business.id, closed: true };
    const unfinished = await this.prisma.order.count({
      where: {
        status: { in: ['CREATED', 'AWAITING_APPROVAL'] },
        createdAt: { gt: new Date(Date.now() - PAYMENT_WINDOW_MS) },
        items: { some: { businessId: business.id } },
      },
    });
    if (unfinished > 0) {
      throw new ConflictException('A buyer is in the middle of paying this business. Please try again in a few minutes.');
    }
    await this.prisma.business.update({ where: { id: business.id }, data: { closedAt: new Date() } });
    return { id: business.id, closed: true };
  }

  /** Opens a closed business again. */
  async reopen(id: string, ownerEmail: unknown) {
    const business = await this.getOwned(id, ownerEmail);
    if (!business.closedAt) return { id: business.id, closed: false };
    await this.prisma.business.update({ where: { id: business.id }, data: { closedAt: null } });
    return { id: business.id, closed: false };
  }

  /**
   * Deletes a business and its listings for good. Only allowed when nothing was ever ordered from it,
   * because orders, receipts and sales point back at it. Otherwise it can be closed instead.
   */
  async remove(id: string, ownerEmail: unknown) {
    const business = await this.getOwned(id, ownerEmail);
    const hasOrders = (await this.prisma.orderItem.count({ where: { businessId: business.id } })) > 0;
    if (hasOrders) {
      throw new ConflictException('This business has order history, so it cannot be deleted. Close it instead.');
    }
    const listings = await this.prisma.listing.findMany({ where: { businessId: business.id }, select: { id: true } });
    try {
      await this.prisma.$transaction([
        this.prisma.ledgerEntry.deleteMany({ where: { businessId: business.id } }),
        this.prisma.listing.deleteMany({ where: { businessId: business.id } }),
        this.prisma.business.delete({ where: { id: business.id } }),
      ]);
    } catch (err) {
      // An order slipped in between the check and the delete: the database refuses, and the business stays.
      if ((err as { code?: string })?.code === 'P2003') {
        throw new ConflictException('This business just received an order, so it cannot be deleted. Close it instead.');
      }
      throw err;
    }
    await Promise.all(listings.map((l) => removeListingImage(l.id).catch(() => undefined)));
    return { id: business.id, deleted: true };
  }

  /** Starts PayPal onboarding and returns the link the owner opens. */
  async connectPaypal(id: string, ownerEmail: unknown) {
    const business = await this.getOwned(id, ownerEmail);
    this.assertOpen(business);
    if (business.onboarding === 'READY') {
      throw new BadRequestException('This business is already connected to PayPal.');
    }
    const link = await this.paypal.createOnboardingLink(business.paypalTrackingId);
    if (!link.onboardingUrl) throw new BadRequestException('PayPal did not return a setup link. Try again.');
    await this.prisma.business.update({ where: { id }, data: { onboarding: 'PENDING' } });
    return { onboardingUrl: link.onboardingUrl };
  }

  /**
   * Asks PayPal where the owner is in the setup, saves the merchant id automatically,
   * and explains in plain words what is still missing.
   */
  async paypalStatus(id: string, ownerEmail: unknown) {
    const business = await this.getOwned(id, ownerEmail);

    let merchantId = business.paypalMerchantId;
    if (!merchantId) {
      try {
        merchantId = (await this.paypal.findMerchantIdByTrackingId(business.paypalTrackingId)).merchantId ?? null;
      } catch {
        merchantId = null; // PayPal does not know this business yet: setup not finished
      }
    }
    if (!merchantId) {
      return {
        onboarding: business.onboarding,
        checks: null,
        fixes:
          business.onboarding === 'PENDING'
            ? ['Finish the steps in the PayPal tab, then check again.']
            : ['Connect your PayPal account to start receiving orders.'],
      };
    }

    let status;
    try {
      status = await this.paypal.getSellerStatus(merchantId);
    } catch {
      return {
        onboarding: business.onboarding,
        checks: null,
        fixes: ['PayPal did not answer just now. Check again in a moment.'],
      };
    }

    const fixes: string[] = [];
    if (!status.permissionsGranted) fixes.push('Approve the permissions PayPal asks for when you connect.');
    if (!status.emailConfirmed) fixes.push('Confirm the email address on your PayPal account.');
    if (!status.paymentsReceivable) fixes.push("Finish setting up your PayPal account so it can receive payments.");

    const onboarding = status.ready ? 'READY' : 'PENDING';
    // Several businesses may share one PayPal account: money for each still goes to that account.
    await this.prisma.business.update({ where: { id }, data: { paypalMerchantId: merchantId, onboarding } });
    return {
      onboarding,
      checks: {
        paymentsReceivable: Boolean(status.paymentsReceivable),
        emailConfirmed: Boolean(status.emailConfirmed),
        permissionsGranted: status.permissionsGranted,
      },
      fixes,
    };
  }

  /**
   * Everything the device needs to answer "what did I make?" and "what is running low?" with no connection:
   * every listing with its price, cost and stock, plus the last 90 days of sales (PayPal and in-person) and restocks.
   * The device keeps this copy and adds its own unsynced entries on top.
   */
  async ledger(id: string, ownerEmail: unknown) {
    const business = await this.getOwned(id, ownerEmail);
    const since = new Date(Date.now() - LEDGER_DAYS * 24 * 60 * 60 * 1000);
    const [listings, stall, items] = await Promise.all([
      this.prisma.listing.findMany({ where: { businessId: business.id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.ledgerEntry.findMany({
        where: { businessId: business.id, at: { gte: since } },
        orderBy: { at: 'desc' },
        take: MAX_LEDGER_ENTRIES,
      }),
      this.prisma.orderItem.findMany({
        where: { businessId: business.id, order: { status: 'COMPLETED', createdAt: { gte: since } } },
        orderBy: { order: { createdAt: 'desc' } },
        take: MAX_LEDGER_ENTRIES,
        include: {
          order: { select: { id: true, createdAt: true, payouts: { where: { businessId: business.id }, select: { paypalFeeCents: true } } } },
        },
      }),
    ]);
    const byId = new Map(listings.map((l) => [l.id, l]));

    // PayPal's fee is recorded once per seller per order: share it across that order's lines by line size.
    const byOrder = new Map<string, typeof items>();
    for (const it of items) byOrder.set(it.orderId, [...(byOrder.get(it.orderId) ?? []), it]);
    const paypalFee = new Map<string, number>();
    for (const lines of byOrder.values()) {
      const fee = lines[0].order.payouts[0]?.paypalFeeCents ?? 0;
      const parts = splitCents(fee, lines.map((l) => l.unitPriceCents * l.quantity));
      lines.forEach((l, i) => paypalFee.set(l.id, parts[i]));
    }

    const entries = [
      ...stall.map((e) => ({
        id: e.clientId,
        source: 'STALL' as const,
        type: e.type,
        listingId: e.listingId,
        title: byId.get(e.listingId)?.title ?? 'Removed listing',
        quantity: e.quantity,
        unitPriceCents: e.unitPriceCents,
        unitCostCents: e.unitCostCents,
        feesCents: 0,
        note: e.note,
        at: e.at.toISOString(),
      })),
      ...items.map((it) => ({
        id: `pp-${it.id}`,
        source: 'PAYPAL' as const,
        type: 'SALE' as const,
        listingId: it.listingId,
        title: byId.get(it.listingId)?.title ?? 'Removed listing',
        quantity: it.quantity,
        unitPriceCents: it.unitPriceCents,
        // Online orders do not store the cost at the time, so today's cost is used.
        unitCostCents: byId.get(it.listingId)?.costCents ?? null,
        feesCents: it.platformFeeCents + (paypalFee.get(it.id) ?? 0),
        note: '',
        at: it.order.createdAt.toISOString(),
      })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));

    return {
      business: { id: business.id, name: business.name, category: business.category, closed: business.closedAt !== null },
      generatedAt: new Date().toISOString(),
      listings: listings.map((l) => ({
        id: l.id,
        title: l.title,
        kind: l.kind,
        unit: l.unit,
        active: l.active,
        priceCents: l.priceCents,
        costCents: l.costCents,
        stockQty: l.stockQty,
        lowStockAt: l.lowStockAt,
      })),
      entries,
    };
  }

  /**
   * Saves stall entries the device recorded (usually while offline) and updates stock.
   * Safe to repeat: an entry whose clientId is already saved is reported as accepted and not counted again.
   * Entries that can never be saved (bad data, a listing from another business) come back in `rejected`
   * so the device can stop retrying them. Returns a fresh ledger so the device can replace its copy.
   */
  async syncLedger(id: string, ownerEmail: unknown, rawEntries: unknown) {
    const business = await this.getOwned(id, ownerEmail);
    const batch = assertBatch(rawEntries);
    const accepted: string[] = [];
    const rejected: { clientId: string; reason: string }[] = [];

    const clean: CleanEntry[] = [];
    for (const raw of batch) {
      const r = cleanEntry(raw);
      if ('reason' in r) rejected.push({ clientId: typeof raw?.clientId === 'string' ? raw.clientId : '', reason: r.reason });
      else clean.push(r.entry);
    }

    // Already saved (a retry after a dropped connection): nothing to do.
    const known = clean.length
      ? await this.prisma.ledgerEntry.findMany({ where: { clientId: { in: clean.map((e) => e.clientId) } }, select: { clientId: true, businessId: true } })
      : [];
    const knownIds = new Map(known.map((k) => [k.clientId, k.businessId]));

    const listings = await this.prisma.listing.findMany({ where: { businessId: business.id } });
    const byId = new Map(listings.map((l) => [l.id, l]));

    // Oldest first, so stock moves in the order things happened.
    for (const e of [...clean].sort((a, b) => a.at.getTime() - b.at.getTime())) {
      if (knownIds.has(e.clientId)) {
        if (knownIds.get(e.clientId) === business.id) accepted.push(e.clientId);
        else rejected.push({ clientId: e.clientId, reason: 'This entry id is already used.' });
        continue;
      }
      if (accepted.includes(e.clientId)) continue; // same entry twice in one batch
      const listing = byId.get(e.listingId);
      if (!listing) {
        rejected.push({ clientId: e.clientId, reason: 'That listing is not part of this business any more.' });
        continue;
      }
      const unitCostCents = e.unitCostCents ?? listing.costCents ?? null;
      const nextStock = stockAfter(listing.stockQty, e.type, e.quantity);
      const listingData: Record<string, unknown> = {};
      if (listing.stockQty === null) {
        if (nextStock !== null) listingData.stockQty = nextStock; // first restock starts the count
      } else {
        // increment/decrement in the database, so a PayPal order paid at the same moment is not lost
        listingData.stockQty = e.type === 'RESTOCK' ? { increment: e.quantity } : { decrement: e.quantity };
      }
      // A restock with a cost is the newest price the owner paid: use it from now on.
      if (e.type === 'RESTOCK' && e.unitCostCents !== null) listingData.costCents = e.unitCostCents;
      try {
        await this.prisma.$transaction([
          this.prisma.ledgerEntry.create({
            data: {
              clientId: e.clientId,
              businessId: business.id,
              listingId: listing.id,
              type: e.type,
              quantity: e.quantity,
              unitPriceCents: e.unitPriceCents,
              unitCostCents,
              note: e.note,
              at: e.at,
            },
          }),
          ...(Object.keys(listingData).length ? [this.prisma.listing.update({ where: { id: listing.id }, data: listingData })] : []),
        ]);
        byId.set(listing.id, { ...listing, stockQty: nextStock, costCents: (listingData.costCents as number | undefined) ?? listing.costCents });
        accepted.push(e.clientId);
      } catch (err) {
        // Another sync saved the same entry a moment ago.
        if ((err as { code?: string })?.code === 'P2002') accepted.push(e.clientId);
        else throw err;
      }
    }

    return { accepted, rejected, ledger: await this.ledger(id, ownerEmail) };
  }
}
