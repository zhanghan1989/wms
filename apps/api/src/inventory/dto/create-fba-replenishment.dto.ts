import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class CreateFbaReplenishmentDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  skuId!: number;

  @IsString()
  @Length(1, 128)
  boxCode!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @IsOptional()
  @IsString()
  @Length(1, 10)
  remark?: string;
}

