import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class UpdateRakutenRmsConnectionDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  serviceSecret?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(2048)
  licenseKey?: string;

  @IsOptional()
  @IsDateString()
  licenseExpiresAt?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1)
  status?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  syncOrders?: boolean;
}
