import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { CreateSkuEditRequestDto } from './dto/create-sku-edit-request.dto';
import { SkuEditRequestsService } from './sku-edit-requests.service';

@Controller('sku-edit-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SkuEditRequestsController {
  constructor(private readonly skuEditRequestsService: SkuEditRequestsService) {}

  @Get()
  async list(): Promise<unknown[]> {
    return this.skuEditRequestsService.list();
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<unknown> {
    return this.skuEditRequestsService.detail(id);
  }

  @Post()
  async create(
    @Body() payload: CreateSkuEditRequestDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.skuEditRequestsService.create(payload, user.id, req.requestId);
  }
}
