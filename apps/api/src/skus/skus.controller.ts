import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { CreateSkuDto } from './dto/create-sku.dto';
import { UpdateSkuDto } from './dto/update-sku.dto';
import { SkusService } from './skus.service';

@Controller('skus')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SkusController {
  constructor(private readonly skusService: SkusService) {}

  @Get()
  async list(@Query('q') q?: string): Promise<unknown[]> {
    return this.skusService.list(q);
  }

  @Post()
  async create(
    @Body() payload: CreateSkuDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.skusService.create(payload, user.id, req.requestId);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() payload: UpdateSkuDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.skusService.update(id, payload, user.id, req.requestId);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<{ success: boolean }> {
    return this.skusService.remove(id, user.id, req.requestId);
  }
}
