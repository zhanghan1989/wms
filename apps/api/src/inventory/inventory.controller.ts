import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { AnyFilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { ConfirmFbaReplenishmentDto } from './dto/confirm-fba-replenishment.dto';
import { CreateAdjustOrderDto } from './dto/create-adjust-order.dto';
import { CreateFbaReplenishmentDto } from './dto/create-fba-replenishment.dto';
import { ManualAdjustDto } from './dto/manual-adjust.dto';
import { MoveProductBetweenBoxesDto } from './dto/move-product-between-boxes.dto';
import { OutboundFbaReplenishmentDto } from './dto/outbound-fba-replenishment.dto';
import {
  BoxSkusQueryDto,
  MasterProductBoxesQueryDto,
  ProductBoxesQueryDto,
  SearchSkuDto,
} from './dto/search-sku.dto';
import { InventoryService } from './inventory.service';

@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('search')
  async search(@Query() query: SearchSkuDto): Promise<unknown[]> {
    return this.inventoryService.searchSkus(query.keyword, query.page, query.pageSize);
  }

  @Get('product-boxes')
  async productBoxes(@Query() query: ProductBoxesQueryDto): Promise<unknown[]> {
    return this.inventoryService.productBoxes(query.skuId);
  }

  @Get('master-product-boxes')
  async masterProductBoxes(@Query() query: MasterProductBoxesQueryDto): Promise<unknown[]> {
    return this.inventoryService.masterProductBoxes(query.productId);
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

  @Post('move-product-between-boxes')
  async moveProductBetweenBoxes(
    @Body() payload: MoveProductBetweenBoxesDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inventoryService.moveProductBetweenBoxes(payload, user.id, req.requestId);
  }

  @Post('fba-replenishments')
  async createFbaReplenishment(
    @Body() payload: CreateFbaReplenishmentDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inventoryService.createFbaReplenishment(payload, user.id, req.requestId);
  }

  @Post('fba-replenishments/:id/confirm')
  async confirmFbaReplenishment(
    @Param('id') id: string,
    @Body() payload: ConfirmFbaReplenishmentDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inventoryService.confirmFbaReplenishment(id, payload, user.id, req.requestId);
  }

  @Post('fba-replenishments/outbound')
  async outboundFbaReplenishments(
    @Body() payload: OutboundFbaReplenishmentDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inventoryService.outboundFbaReplenishments(payload, user.id, req.requestId);
  }

  @Post('fba-replenishments/:id/delete')
  async deleteFbaReplenishment(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inventoryService.deleteFbaReplenishment(id, user.id, req.requestId);
  }

  @Post('fba-replenishments/:id/reopen')
  async reopenFbaReplenishment(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inventoryService.reopenFbaReplenishment(id, user.id, req.requestId);
  }

  @Get('fba-replenishments')
  async listFbaReplenishments(): Promise<unknown[]> {
    return this.inventoryService.listFbaReplenishments();
  }

  @Get('fba-replenishments/pending-summary')
  async getFbaPendingSummary(): Promise<unknown> {
    return this.inventoryService.getFbaPendingSummary();
  }

  @Get('fba-replenishments/outbound-excel')
  async downloadFbaReplenishmentsExcel(@Res() res: Response): Promise<void> {
    const file = await this.inventoryService.buildFbaReplenishmentsExcel();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    res.setHeader('Content-Length', String(file.content.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(file.content);
  }

  @Get('sku-totals')
  async getSkuInventoryTotals(): Promise<Record<string, number>> {
    return this.inventoryService.getSkuInventoryTotals();
  }

  @Get('dashboard')
  async getOverviewDashboard(
    @Query('includeFba') includeFba?: string,
    @Query('fbaSnapshotId') fbaSnapshotId?: string,
  ): Promise<unknown> {
    return this.inventoryService.getOverviewDashboard({
      includeFba: includeFba === 'true',
      fbaSnapshotId,
    });
  }

  @Post('dashboard/fba-sales-report')
  @UseInterceptors(FileInterceptor('file'))
  async importFbaSalesReport(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string; size?: number } | undefined,
    @Body() body: { periodStart?: string; periodEnd?: string },
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    if (!file?.buffer) {
      throw new BadRequestException('请上传最近90天、包含SKU列的亚马逊销售报告CSV');
    }
    if (file.size && file.size > 10 * 1024 * 1024) {
      throw new BadRequestException('CSV文件不能超过10MB');
    }
    return this.inventoryService.importFbaSalesReport(
      file.buffer,
      file.originalname,
      body.periodStart,
      body.periodEnd,
      user.id,
    );
  }

  @Post('dashboard/amazon-replenishment-reports')
  @UseInterceptors(AnyFilesInterceptor({ limits: { files: 2, fileSize: 10 * 1024 * 1024 } }))
  async importAmazonReplenishmentReports(
    @UploadedFiles()
    files: Array<{ buffer?: Buffer; originalname?: string; fieldname?: string }> | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    const businessFile = (files ?? []).find((file) => file.fieldname === 'businessFile');
    const inventoryFile = (files ?? []).find((file) => file.fieldname === 'inventoryFile');
    if (!businessFile?.buffer || !inventoryFile?.buffer) {
      throw new BadRequestException('请同时上传按子ASIN销售报告和FBA库存报告');
    }
    return this.inventoryService.importAmazonReplenishmentReports(
      businessFile.buffer,
      businessFile.originalname,
      inventoryFile.buffer,
      inventoryFile.originalname,
      user.id,
    );
  }

  @Get('dashboard/amazon-replenishment-reports/latest')
  async getLatestAmazonReplenishmentReports(): Promise<unknown> {
    return this.inventoryService.getLatestAmazonReplenishmentReports();
  }

  @Get('dashboard/amazon-replenishment-support')
  async getAmazonReplenishmentSupportData(): Promise<unknown> {
    return this.inventoryService.getAmazonReplenishmentSupportData();
  }

  @Get('dashboard/production-recommendations-excel')
  async downloadProductionRecommendationsExcel(
    @Res() res: Response,
    @Query('includeFba') includeFba?: string,
    @Query('fbaSnapshotId') fbaSnapshotId?: string,
  ): Promise<void> {
    const file = await this.inventoryService.buildProductionRecommendationsExcel({
      includeFba: includeFba === 'true',
      fbaSnapshotId,
    });
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    res.setHeader('Content-Length', String(file.content.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(file.content);
  }

  @Get('print-agent-windows-exe')
  async downloadPrintAgentWindowsExe(@Res() res: Response): Promise<void> {
    const file = await this.inventoryService.buildPrintAgentWindowsExe();
    res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Content-Length', String(file.content.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(file.content);
  }

  @Get('bulk-update-template')
  async downloadBulkUpdateTemplate(@Res() res: Response): Promise<void> {
    const file = await this.inventoryService.getBulkUpdateTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    res.setHeader('Content-Length', String(file.content.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(file.content);
  }

  @Post('bulk-update-excel')
  @UseInterceptors(FileInterceptor('file'))
  async importBulkUpdateExcel(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    if (!file?.buffer) {
      throw new BadRequestException('请上传Excel文件');
    }
    return this.inventoryService.importBulkUpdateExcel(
      file.buffer,
      file.originalname,
      user.id,
      req.requestId,
    );
  }
}
