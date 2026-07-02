import { IsObject, IsOptional } from 'class-validator';

export class ConfirmBatchInboundDto {
  @IsOptional()
  @IsObject()
  actualQuantities?: Record<string, unknown>;
}
