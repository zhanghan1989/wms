import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ExportMasterProductsDto {
  @IsOptional()
  @IsString()
  @Transform(trimString)
  keyword?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  productId?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  productName?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  productType?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  bagBrand?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  color?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  bagName?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  bagType?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  zipperStyle?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  style?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  pattern?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  buckleType?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  matchingBagType?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  length?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  width?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  patternType?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  size?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stockQtyMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999999999)
  stockQtyMax?: number;
}
