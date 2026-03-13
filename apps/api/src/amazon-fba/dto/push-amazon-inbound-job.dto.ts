import { IsOptional, IsString, Length } from 'class-validator';

export class PushAmazonInboundJobDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  idempotencyKey?: string;
}
