import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { AuditAction } from '@prisma/client';
import { AuditEventType } from '../../constants/audit-event-type';

const auditEventTypes = Object.values(AuditEventType);

export class QueryAuditDto {
  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  entityId?: number;

  @IsOptional()
  @IsString()
  @IsIn(auditEventTypes)
  eventType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  operatorId?: number;

  @IsOptional()
  @IsIn(['create', 'update', 'delete'])
  action?: AuditAction;

  @IsOptional()
  @IsString()
  dateFrom?: string;

  @IsOptional()
  @IsString()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize = 20;
}
