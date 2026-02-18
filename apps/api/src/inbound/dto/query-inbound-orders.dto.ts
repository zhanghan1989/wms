import { IsEnum, IsOptional } from 'class-validator';
import { OrderStatus } from '@prisma/client';

export class QueryInboundOrdersDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}
