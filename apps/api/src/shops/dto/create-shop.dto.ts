import { ShopPlatform } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateShopDto {
  @IsString()
  @Length(1, 128)
  name!: string;

  @IsEnum(ShopPlatform)
  platform!: ShopPlatform;

  @IsOptional()
  @Min(0)
  @Max(1)
  status?: number;
}
