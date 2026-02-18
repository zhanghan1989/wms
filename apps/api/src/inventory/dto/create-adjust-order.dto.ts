import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  NotEquals,
  ValidateNested,
} from 'class-validator';

export class CreateAdjustOrderItemDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  boxId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  skuId!: number;

  @Type(() => Number)
  @IsInt()
  @NotEquals(0)
  qtyDelta!: number;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  reason?: string;
}

export class CreateAdjustOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateAdjustOrderItemDto)
  items!: CreateAdjustOrderItemDto[];

  @IsOptional()
  @IsString()
  @Length(1, 255)
  remark?: string;
}
