import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Length, Min, ValidateNested } from 'class-validator';

export class CreateInboundOrderItemDto {
  @IsString()
  @Length(1, 128)
  boxCode!: string;

  @IsString()
  @Length(1, 128)
  sku!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sourceRowNo?: number;
}

export class CreateInboundOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateInboundOrderItemDto)
  items!: CreateInboundOrderItemDto[];

  @IsOptional()
  @IsString()
  @Length(1, 255)
  remark?: string;
}
