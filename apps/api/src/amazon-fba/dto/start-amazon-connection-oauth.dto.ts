import { IsOptional, IsString, MaxLength } from 'class-validator';

export class StartAmazonConnectionOauthDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  origin?: string;
}
