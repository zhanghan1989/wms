import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CompleteAmazonConnectionOauthDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  origin?: string;

  @IsString()
  @Length(1, 255)
  state!: string;

  @IsString()
  @Length(1, 128)
  sellingPartnerId!: string;

  @IsString()
  @Length(1, 2048)
  spapiOauthCode!: string;
}
