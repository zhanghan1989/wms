import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class StartAmazonOAuthDto {
  @IsString()
  @Matches(/^\d+$/)
  shopId!: string;

  @IsString()
  @IsIn(['NA', 'EU', 'FE'])
  region!: 'NA' | 'EU' | 'FE';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  marketplaceIds!: string[];

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  syncFbmOrders?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  syncFbaOrders?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  syncFbaInventory?: boolean;
}
