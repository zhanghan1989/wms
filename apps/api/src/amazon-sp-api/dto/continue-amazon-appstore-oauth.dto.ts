import { IsIn, IsOptional, IsString, IsUrl, Matches, MaxLength } from 'class-validator';
import { StartAmazonOAuthDto } from './start-amazon-oauth.dto';

export class ContinueAmazonAppstoreOAuthDto extends StartAmazonOAuthDto {
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  amazonCallbackUri!: string;

  @IsString()
  @MaxLength(2048)
  amazonState!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,64}$/)
  sellingPartnerId!: string;

  @IsOptional()
  @IsString()
  @IsIn(['beta'])
  version?: 'beta';
}
