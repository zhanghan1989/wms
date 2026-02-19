import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class SearchSkuDto {
  @IsOptional()
  @IsString()
  @Length(1, 128)
  keyword?: string;
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
