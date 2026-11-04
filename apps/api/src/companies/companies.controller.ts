import { BadRequestException, Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { AuditAction, AuditEventType, Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { parseId } from '../common/utils';
import { companyContext } from '../company-scope/company-context';
class CompanyDto {
  @IsString() @Length(1, 128) name!: string;
  @IsOptional() @IsInt() @Min(0) @Max(1) status?: number;
}
@Controller('companies')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompaniesController {
  constructor(private readonly prisma: PrismaService) {}
  @Get()
  list(): Promise<unknown> {
    return this.prisma.company.findMany({ orderBy: { id: 'asc' } });
  }
  @Post() @Roles(Role.system_admin)
  async create(@Body() dto: CompanyDto, @CurrentUser() user: AuthUser): Promise<unknown> {
    if (!dto.name.trim()) throw new BadRequestException('公司名称不能为空');
    if (dto.name.trim() === '日本海外仓') throw new BadRequestException('日本海外仓为系统保留的共享仓储组织');
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.company.create({ data: { name: dto.name.trim(), status: dto.status ?? 1 } });
      await companyContext.run({ companyId: created.id, systemAdmin: true, warehouse: false, userId: user.id }, async () => {
        await tx.operationAuditLog.create({ data: { entityType: 'company', entityId: created.id,
          action: AuditAction.create, eventType: AuditEventType.company_created, operatorId: user.id,
          afterData: { name: created.name, status: created.status } } });
      });
      return created;
    });
  }
  @Put(':id') @Roles(Role.system_admin)
  async update(@Param('id') id: string, @Body() dto: CompanyDto, @CurrentUser() user: AuthUser): Promise<unknown> {
    if (!dto.name.trim()) throw new BadRequestException('公司名称不能为空');
    if (dto.name.trim() === '日本海外仓') throw new BadRequestException('日本海外仓为系统保留的共享仓储组织');
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.company.findUniqueOrThrow({ where: { id: parseId(id, 'companyId') } });
      const updated = await tx.company.update({ where: { id: before.id }, data: { name: dto.name.trim(), status: dto.status } });
      await companyContext.run({ companyId: updated.id, systemAdmin: true, warehouse: false, userId: user.id }, async () => {
        await tx.operationAuditLog.create({ data: { entityType: 'company', entityId: updated.id,
          action: AuditAction.update, eventType: AuditEventType.company_updated, operatorId: user.id,
          beforeData: { name: before.name, status: before.status }, afterData: { name: updated.name, status: updated.status } } });
      });
      return updated;
    });
  }
}
