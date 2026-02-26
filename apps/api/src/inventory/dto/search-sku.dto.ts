import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class SearchSkuDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 128)
  keyword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

export class ProductBoxesQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  skuId!: number;
}

export class BoxSkusQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  boxId!: number;
}
