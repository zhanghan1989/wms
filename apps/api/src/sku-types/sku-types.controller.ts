import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { CreateSkuTypeDto } from './dto/create-sku-type.dto';
import { UpdateSkuTypeDto } from './dto/update-sku-type.dto';
import { SkuTypesService } from './sku-types.service';

@Controller('sku-types')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SkuTypesController {
  constructor(private readonly skuTypesService: SkuTypesService) {}

  @Get()
  async list(@Query('q') q?: string): Promise<unknown[]> {
    return this.skuTypesService.list(q);
  }

  @Post()
  async create(
    @Body() payload: CreateSkuTypeDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.skuTypesService.create(payload, user.id, req.requestId);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() payload: UpdateSkuTypeDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.skuTypesService.update(id, payload, user.id, req.requestId);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<{ success: boolean }> {
    return this.skuTypesService.remove(id, user.id, req.requestId);
  }
}
