import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { ThirdPartyApiKeyGuard } from '../orders/third-party-api-key.guard';
import { CreateMasterProductFbaReplenishmentDto } from './dto/create-master-product-fba-replenishment.dto';
import { CreateMasterProductOutboundOneDto } from './dto/create-master-product-outbound-one.dto';
import { ExportMasterProductsDto } from './dto/export-master-products.dto';
import { ManualAdjustMasterProductBoxDto } from './dto/manual-adjust-master-product-box.dto';
import { UpdateMasterProductPrintSettingsDto } from './dto/update-master-product-print-settings.dto';
import { MasterProductsService } from './master-products.service';

@Controller('master-products')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MasterProductsController {
  constructor(private readonly masterProductsService: MasterProductsService) {}

  @Get()
  async list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ): Promise<unknown> {
    return this.masterProductsService.list(page, pageSize, keyword);
  }

  @Get('sync-records')
  async listSyncRecords(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.masterProductsService.listSyncRecords(page, pageSize);
  }

  @Get(':productId/detail')
  async detail(@Param('productId') productId: string): Promise<unknown> {
    return this.masterProductsService.detail(productId);
  }

  @Get('export-filter-options')
  async getExportFilterOptions(): Promise<unknown> {
    return this.masterProductsService.getExportFilterOptions();
  }

  @Get('upload-template')
  async downloadUploadTemplate(@Res() res: Response): Promise<void> {
    const file = await this.masterProductsService.getUploadTemplate();
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

  @Post('sync-xiya')
  async syncFromXiya(
    @Query('days') days: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return this.masterProductsService.triggerXiyaSync(days, {
      operationType: 'manual_sync',
      operatorId: user.id,
      operatorName: user.username,
    });
  }

  @Post('export-excel')
  async exportExcel(
    @Body() payload: ExportMasterProductsDto,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.masterProductsService.exportExcel(payload);
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

  @Get('overseas-warehouse-stock-excel')
  async exportOverseasWarehouseStockExcel(@Res() res: Response): Promise<void> {
    const file = await this.masterProductsService.exportOverseasWarehouseStockExcel();
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

  @Post(':productId/box-inventories/manual-adjust')
  async manualAdjustBoxInventory(
    @Param('productId') productId: string,
    @Body() payload: ManualAdjustMasterProductBoxDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.masterProductsService.manualAdjustBoxInventory(
      productId,
      payload,
      user.id,
      req.requestId,
    );
  }

  @Post(':productId/print-settings')
  async updatePrintSettings(
    @Param('productId') productId: string,
    @Body() payload: UpdateMasterProductPrintSettingsDto,
  ): Promise<unknown> {
    return this.masterProductsService.updatePrintSettings(productId, payload);
  }

  @Post(':productId/fba-replenishments')
  async createFbaReplenishment(
    @Param('productId') productId: string,
    @Body() payload: CreateMasterProductFbaReplenishmentDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.masterProductsService.createFbaReplenishment(
      productId,
      payload,
      user.id,
      req.requestId,
    );
  }

  @Post(':productId/box-inventories/outbound-one')
  async outboundOne(
    @Param('productId') productId: string,
    @Body() payload: CreateMasterProductOutboundOneDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.masterProductsService.outboundOneByProduct(productId, payload, user.id, req.requestId);
  }

  @Post('import-excel')
  @UseInterceptors(FileInterceptor('file'))
  async importExcel(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    if (!file?.buffer) {
      throw new BadRequestException('\\u8bf7\\u9009\\u62e9 Excel \\u6587\\u4ef6');
    }
    return this.masterProductsService.importExcel(file.buffer, file.originalname, {
      operationType: 'bulk_upload',
      operatorId: user.id,
      operatorName: user.username,
      sourceFileName: file.originalname,
    });
  }
}

@Controller('master-products')
export class MasterProductsThirdPartyController {
  constructor(private readonly masterProductsService: MasterProductsService) {}

  @Get('available-stock')
  @UseGuards(ThirdPartyApiKeyGuard)
  async exportAvailableStock(): Promise<unknown> {
    return this.masterProductsService.exportAvailableStockForThirdParty();
  }
}
