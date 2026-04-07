import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class CreateMasterProductOutboundOneDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  skuId?: number;

  @IsString()
  @Length(1, 128)
  boxCode!: string;

  @IsOptional()
  @IsString()
  @Length(1, 10)
  remark?: string;
}
