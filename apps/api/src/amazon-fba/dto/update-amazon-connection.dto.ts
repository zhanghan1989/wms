import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, Length, MaxLength, Min } from 'class-validator';

export class UpdateAmazonConnectionDto {
  @IsOptional()
  @IsString()
  @Length(1, 128)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  marketplaceId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  region?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  sellerId?: string;

  @IsOptional()
  @IsObject()
  authConfig?: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  status?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}
