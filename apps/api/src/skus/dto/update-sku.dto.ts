import { IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class UpdateSkuDto {
  @IsOptional()
  @IsString()
  @Length(1, 128)
  erpSku?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  asin?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  fnsku?: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  model?: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  desc1?: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  desc2?: string;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  shop?: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  remark?: string;

  @IsOptional()
  @Min(0)
  @Max(1)
  status?: number;
}
