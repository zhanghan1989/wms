import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  Put,
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
import { CreateShoulderStrapPartDto } from './dto/create-shoulder-strap-part.dto';
import { ExportMasterProductsDto } from './dto/export-master-products.dto';
import { ManualAdjustMasterProductBoxDto } from './dto/manual-adjust-master-product-box.dto';
import { UpdateMasterProductPrintSettingsDto } from './dto/update-master-product-print-settings.dto';
import { UpdateMasterProductBomDto } from './dto/update-master-product-bom.dto';
import { UpdateShoulderStrapPartDto } from './dto/update-shoulder-strap-part.dto';
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

  @Get('shoulder-straps')
  async listShoulderStraps(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ): Promise<unknown> {
    return this.masterProductsService.listShoulderStraps(page, pageSize, keyword);
  }

  @Get('shoulder-strap-parts')
  async listShoulderStrapParts(
    @Query('keyword') keyword?: string,
  ): Promise<unknown> {
    return this.masterProductsService.listShoulderStrapParts(keyword);
  }

  @Post('shoulder-strap-parts')
  async createShoulderStrapPart(
    @Body() payload: CreateShoulderStrapPartDto,
  ): Promise<unknown> {
    return this.masterProductsService.createShoulderStrapPart(payload);
  }

  @Get('shoulder-strap-parts/:partId/movements')
  async listShoulderStrapPartMovements(@Param('partId') partId: string): Promise<unknown> {
    return this.masterProductsService.listShoulderStrapPartMovements(partId);
  }

  @Put('shoulder-strap-parts/:partId')
  async updateShoulderStrapPart(
    @Param('partId') partId: string,
    @Body() payload: UpdateShoulderStrapPartDto,
  ): Promise<unknown> {
    return this.masterProductsService.updateShoulderStrapPart(partId, payload);
  }

  @Delete('shoulder-strap-parts/:partId')
  async deleteShoulderStrapPart(@Param('partId') partId: string): Promise<unknown> {
    return this.masterProductsService.deleteShoulderStrapPart(partId);
  }

  @Get(':productId/bom')
  async getBom(@Param('productId') productId: string): Promise<unknown> {
    return this.masterProductsService.getBom(productId);
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
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent('产品主表分类下载.csv')}`,
    );
    res.setHeader('Cache-Control', 'no-store');
    try {
      await this.masterProductsService.streamExportCsv(payload, res);
      res.end();
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      throw error;
    }
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

  @Put(':productId/bom')
  async updateBom(
    @Param('productId') productId: string,
    @Body() payload: UpdateMasterProductBomDto,
  ): Promise<unknown> {
    return this.masterProductsService.updateBom(productId, payload);
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
