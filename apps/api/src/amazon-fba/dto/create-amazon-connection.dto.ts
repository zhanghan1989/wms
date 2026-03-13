import { IsObject, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CreateAmazonConnectionDto {
  @IsString()
  @Length(1, 128)
  name!: string;

  @IsString()
  @Length(1, 32)
  marketplaceId!: string;

  @IsString()
  @Length(1, 32)
  region!: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  sellerId?: string;

  @IsOptional()
  @IsObject()
  authConfig!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}
