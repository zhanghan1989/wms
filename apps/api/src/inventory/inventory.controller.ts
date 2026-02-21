import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { CreateAdjustOrderDto } from './dto/create-adjust-order.dto';
import { CreateFbaReplenishmentDto } from './dto/create-fba-replenishment.dto';
import { ManualAdjustDto } from './dto/manual-adjust.dto';
import { BoxSkusQueryDto, ProductBoxesQueryDto, SearchSkuDto } from './dto/search-sku.dto';
import { InventoryService } from './inventory.service';

@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('search')
  async search(@Query() query: SearchSkuDto): Promise<unknown[]> {
    return this.inventoryService.searchSkus(query.keyword);
  }

  @Get('product-boxes')
  async productBoxes(@Query() query: ProductBoxesQueryDto): Promise<unknown[]> {
    return this.inventoryService.productBoxes(query.skuId);
  }

  @Get('box-skus')
  async boxSkus(@Query() query: BoxSkusQueryDto): Promise<unknown[]> {
    return this.inventoryService.boxSkus(query.boxId);
  }

  @Post('adjust-orders')
  async createAdjustOrder(
    @Body() payload: CreateAdjustOrderDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inventoryService.createAdjustOrder(payload, user.id, req.requestId);
  }

  @Post('adjust-orders/:id/confirm')
  async confirmAdjustOrder(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inventoryService.confirmAdjustOrder(id, user.id, req.requestId);
  }

  @Post('manual-adjust')
  async manualAdjust(
    @Body() payload: ManualAdjustDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inventoryService.manualAdjust(payload, user.id, req.requestId);
  }

  @Post('fba-replenishments')
  async createFbaReplenishment(
    @Body() payload: CreateFbaReplenishmentDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inventoryService.createFbaReplenishment(payload, user.id, req.requestId);
  }

  @Get('fba-replenishments')
  async listFbaReplenishments(): Promise<unknown[]> {
    return this.inventoryService.listFbaReplenishments();
  }

  @Get('fba-replenishments/pending-summary')
  async getFbaPendingSummary(): Promise<unknown> {
    return this.inventoryService.getFbaPendingSummary();
  }
}
