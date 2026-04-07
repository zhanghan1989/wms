import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class ManualAdjustMasterProductBoxDto {
  @IsString()
  @Length(1, 128)
  boxCode!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qtyDelta!: number;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  reason?: string;
}
