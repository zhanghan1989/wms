import { Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { StocktakePlannerService } from './stocktake-planner.service';

@Controller('stocktake-planner')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StocktakePlannerController {
  constructor(private readonly stocktakePlannerService: StocktakePlannerService) {}

  @Get('tasks')
  async list(): Promise<unknown[]> {
    return this.stocktakePlannerService.list();
  }

  @Post('tasks/generate')
  async generate(
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown[]> {
    return this.stocktakePlannerService.generate(user.id, req.requestId);
  }

  @Post('tasks/clear-future')
  async clearFuture(
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<{ success: true; deletedCount: number; tasks: unknown[] }> {
    if (!['admin', 'system_admin'].includes(String(user.role || ''))) {
      throw new ForbiddenException('只有管理员可以清理未来盘点任务');
    }
    return this.stocktakePlannerService.clearFuture(user.id, req.requestId);
  }

  @Post('tasks/:id/confirm')
  async confirm(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.stocktakePlannerService.confirm(id, user.id, req.requestId);
  }
}
