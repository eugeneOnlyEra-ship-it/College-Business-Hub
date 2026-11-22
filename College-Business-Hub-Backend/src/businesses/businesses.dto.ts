import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OwnerDto {
  /** Ignored: the owner now comes from the sign-in token. Kept so internal calls stay typed. */
  ownerEmail?: string;
}

export class CreateBusinessDto extends OwnerDto {
  @ApiPropertyOptional({ example: 'Amina' })
  ownerName?: string;

  @ApiProperty({ example: 'Laptop Fix Corner' })
  name: string;

  @ApiProperty({ example: 'repairs', description: 'e.g. printing, salon, groceries, transport, repairs' })
  category: string;

  @ApiPropertyOptional({ example: 'Screen and battery repairs near the hostels.' })
  description?: string;
}

export class CreateListingDto extends OwnerDto {
  @ApiProperty({ example: 'Screen repair' })
  title: string;

  @ApiPropertyOptional({ example: 'Most laptop models, same day.' })
  description?: string;

  @ApiPropertyOptional({ enum: ['PRODUCT', 'SERVICE'], default: 'SERVICE' })
  kind?: 'PRODUCT' | 'SERVICE';

  @ApiProperty({ example: 4500, description: 'Price in cents (4500 = $45.00). From 50 to 10000.' })
  priceCents: number;

  @ApiPropertyOptional({ example: 'per repair' })
  unit?: string;

  @ApiPropertyOptional({ example: 24, description: 'Units on hand. Leave out for services.' })
  stockQty?: number | null;

  @ApiPropertyOptional({ example: 5, description: 'Warn when stock is at or below this.' })
  lowStockAt?: number | null;

  @ApiPropertyOptional({ example: 2000, description: 'What one unit costs you, in cents. Used to work out profit.' })
  costCents?: number | null;
}

export class ListingImageDto extends OwnerDto {
  @ApiProperty({ description: 'The photo as base64 or a data URL. JPEG, PNG or WebP, up to 1 MB.' })
  data: string;
}

export class UpdateBusinessDto extends OwnerDto {
  @ApiPropertyOptional({ example: 'Laptop Fix Corner' }) name?: string;
  @ApiPropertyOptional({ example: 'repairs' }) category?: string;
  @ApiPropertyOptional({ example: 'Screen and battery repairs near the hostels.' }) description?: string;
}

export class UpdateListingDto extends OwnerDto {
  @ApiPropertyOptional({ example: 'Screen repair' }) title?: string;
  @ApiPropertyOptional({ example: 'Most laptop models, same day.' }) description?: string;
  @ApiPropertyOptional({ enum: ['PRODUCT', 'SERVICE'] }) kind?: 'PRODUCT' | 'SERVICE';
  @ApiPropertyOptional({ example: 4500, description: 'Price in cents. From 50 to 10000.' }) priceCents?: number;
  @ApiPropertyOptional({ example: 'per repair' }) unit?: string;
  @ApiPropertyOptional({ description: 'false hides the listing from search and checkout; true shows it again.' }) active?: boolean;
  @ApiPropertyOptional({ example: 24, description: 'Units on hand. null stops tracking.' }) stockQty?: number | null;
  @ApiPropertyOptional({ example: 5, description: 'Warn when stock is at or below this. null uses the default.' }) lowStockAt?: number | null;
  @ApiPropertyOptional({ example: 2000, description: 'What one unit costs you, in cents. null = unknown.' }) costCents?: number | null;
}

export class LedgerEntryDto {
  @ApiProperty({ example: 'k3j9x0aa71', description: 'Made on the device. Sending the same id again never counts twice.' }) clientId: string;
  @ApiProperty() listingId: string;
  @ApiProperty({ enum: ['SALE', 'RESTOCK'] }) type: 'SALE' | 'RESTOCK';
  @ApiProperty({ example: 3 }) quantity: number;
  @ApiPropertyOptional({ example: 150, description: 'SALE only: what the buyer paid per unit, in cents.' }) unitPriceCents?: number;
  @ApiPropertyOptional({ example: 90, description: 'Cost per unit in cents. On a RESTOCK it also becomes the listing cost.' }) unitCostCents?: number;
  @ApiPropertyOptional({ example: 'cash' }) note?: string;
  @ApiProperty({ example: '2026-11-22T09:30:00.000Z', description: 'When it happened on the stall.' }) at: string;
}

export class SyncLedgerDto {
  @ApiProperty({ type: [LedgerEntryDto] }) entries: LedgerEntryDto[];
}
