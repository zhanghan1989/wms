import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  NotEquals,
} from 'class-validator';

export class ManualAdjustDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  skuId?: number;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  keyword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  boxId?: number;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  boxCode?: string;

  @Type(() => Number)
  @IsInt()
  @NotEquals(0)
  qtyDelta!: number;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  reason?: string;
}
