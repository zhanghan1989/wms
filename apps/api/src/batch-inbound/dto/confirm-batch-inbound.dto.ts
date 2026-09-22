import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConfirmBatchInboundDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  differenceReason?: string;

  @IsOptional()
  @IsObject()
  actualQuantities?: Record<string, unknown>;
}
