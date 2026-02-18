import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { parseId } from '../common/utils';
import { QueryAuditDto } from './dto/query-audit.dto';
import { AuditService } from './audit.service';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('audit-logs')
  async query(@Query() query: QueryAuditDto): Promise<{ total: number; items: unknown[] }> {
    return this.auditService.query(query);
  }

  @Get('boxes/:id/audit-logs')
  async queryBoxLogs(@Param('id') id: string): Promise<unknown[]> {
    return this.auditService.queryByEntity('box', parseId(id, 'boxId'));
  }

  @Get('skus/:id/audit-logs')
  async querySkuLogs(@Param('id') id: string): Promise<unknown[]> {
    return this.auditService.queryByEntity('sku', parseId(id, 'skuId'));
  }
}
