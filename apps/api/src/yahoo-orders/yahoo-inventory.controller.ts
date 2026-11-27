import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { YahooInventoryService } from './yahoo-inventory.service';

@Controller('yahoo-orders/inventory')
@Roles(Role.admin)
@UseGuards(JwtAuthGuard, RolesGuard)
export class YahooInventoryController {
  constructor(private readonly inventory: YahooInventoryService) {}

  @Get()
  status() {
    return this.inventory.status();
  }

  @Post('check')
  check(@Body() body: Record<string, unknown>) {
    return this.inventory.test(body ?? {});
  }

  @Put('mappings')
  save(@Body() body: Record<string, unknown>) {
    return this.inventory.saveMapping(body ?? {});
  }

  @Post('mappings/auto-match')
  match(@Body() body: Record<string, unknown>) {
    return this.inventory.autoMatch(body ?? {});
  }

  @Post('mappings/:id/disable')
  disable(@Param('id') id: string) {
    return this.inventory.disableMapping(id);
  }

  @Put('enabled')
  setEnabled(@Body('enabled') enabled: unknown) {
    if (typeof enabled !== 'boolean') throw new BadRequestException('请选择是否开启雅虎库存同步');
    return this.inventory.setEnabled(enabled);
  }

  @Post('preview')
  preview(@CurrentUser() user: AuthUser) {
    return this.inventory.preview(user.id.toString());
  }

  @Post('execute')
  execute(@CurrentUser() user: AuthUser, @Body('previewId') id: unknown) {
    if (typeof id !== 'string') throw new BadRequestException('缺少库存预览编号');
    return this.inventory.execute(user.id.toString(), id);
  }

  @Get('jobs/:id')
  job(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('page') page?: string) {
    const parsed = Number(page ?? 1);
    return this.inventory.job(user.id.toString(), id, Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1);
  }
}
