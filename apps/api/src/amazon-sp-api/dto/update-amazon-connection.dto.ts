import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateAmazonConnectionDto {
  @IsOptional()
  @IsString()
  @IsIn(['NA', 'EU', 'FE'])
  region?: 'NA' | 'EU' | 'FE';

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  marketplaceIds?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1)
  status?: number;

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
