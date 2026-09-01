import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateRakutenRmsConnectionDto {
  @IsString()
  @Matches(/^\d+$/)
  shopId!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(512)
  serviceSecret!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(2048)
  licenseKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  smtpAuthId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  smtpAuthPassword?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  smtpFromAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  smtpFromName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  smtpBccAddresses?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  mailNotificationsEnabled?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  autoShippingEnabled?: boolean;

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
