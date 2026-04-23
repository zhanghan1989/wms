import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Put,
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
import { OrdersService } from './orders.service';
import { ThirdPartyApiKeyGuard } from './third-party-api-key.guard';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  async list(@Query('limit') limit?: string): Promise<unknown[]> {
    return this.ordersService.list(limit);
  }

  @Get('amazon')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async listAmazon(@Query('limit') limit?: string): Promise<unknown[]> {
    return this.ordersService.listAmazon(limit);
  }

  @Get('manual')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async listAmazonManualOrders(@Query('limit') limit?: string): Promise<unknown[]> {
    return this.ordersService.listAmazonManualOrders(limit);
  }

  @Put('rakuten/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async updateRakutenOrder(
    @Param('id') id: string,
    @Body()
    payload: {
      orderId?: string | null;
      skuCode?: string | null;
      orderQuantity?: string | number | null;
      productName?: string | null;
      mallName?: string | null;
      shopName?: string | null;
      productId?: string | null;
      shippingName?: string | null;
      shippingPostalCode?: string | null;
      shippingPrefecture?: string | null;
      shippingCity?: string | null;
      shippingAddress?: string | null;
      shippingPhone?: string | null;
      shipmentCompany?: string | null;
      shipmentNo?: string | null;
      deliveryDateRaw?: string | null;
      deliveryTimeSlot?: string | null;
      orderRemark?: string | null;
    },
  ): Promise<unknown> {
    return this.ordersService.updateRakutenOrder(id, payload);
  }

  @Put('amazon/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async updateAmazonOrder(
    @Param('id') id: string,
    @Body()
    payload: {
      orderId?: string | null;
      orderItemId?: string | null;
      sku?: string | null;
      quantityPurchased?: string | number | null;
      productName?: string | null;
      mallName?: string | null;
      shopName?: string | null;
      productId?: string | null;
      recipientName?: string | null;
      buyerPhoneNumber?: string | null;
      shipPostalCode?: string | null;
      shipState?: string | null;
      shipAddress1?: string | null;
      shipAddress2?: string | null;
      shipAddress3?: string | null;
      shipmentCompany?: string | null;
      shipmentNo?: string | null;
    },
  ): Promise<unknown> {
    return this.ordersService.updateAmazonOrder(id, payload);
  }

  @Post('manual')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async createAmazonManualOrder(
    @Body()
    payload: {
      orderId?: string | null;
      orderItemId?: string | null;
      sku?: string | null;
      productId?: string | null;
      quantityPurchased?: string | number | null;
      productName?: string | null;
      mallName?: string | null;
      shopName?: string | null;
      recipientName?: string | null;
      buyerPhoneNumber?: string | null;
      shipPostalCode?: string | null;
      shipState?: string | null;
      shipAddress1?: string | null;
      shipAddress2?: string | null;
      shipAddress3?: string | null;
      shipmentCompany?: string | null;
      shipmentNo?: string | null;
    },
  ): Promise<unknown> {
    return this.ordersService.createAmazonManualOrder(payload);
  }

  @Post('manual/batch')
  @UseGuards(ThirdPartyApiKeyGuard)
  async batchCreateAmazonManualOrders(
    @Body()
    payload: {
      items?: Array<{
        orderId?: string | null;
        orderItemId?: string | null;
        sku?: string | null;
        productId?: string | null;
        quantityPurchased?: string | number | null;
        productName?: string | null;
        mallName?: string | null;
        shopName?: string | null;
        recipientName?: string | null;
        buyerPhoneNumber?: string | null;
        shipPostalCode?: string | null;
        shipState?: string | null;
        shipAddress1?: string | null;
        shipAddress2?: string | null;
        shipAddress3?: string | null;
        shipmentCompany?: string | null;
        shipmentNo?: string | null;
      }>;
    },
  ): Promise<unknown> {
    return this.ordersService.batchCreateAmazonManualOrders(payload);
  }

  @Get('overseas-warehouse')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async listOverseasWarehouse(@Query('limit') limit?: string): Promise<unknown[]> {
    return this.ordersService.listOverseasWarehouse(limit);
  }

  @Post('overseas-warehouse/:source/:id/switch-to-china')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async switchOverseasWarehouseOrderToChina(
    @Param('source') source: string,
    @Param('id') id: string,
  ): Promise<unknown> {
    return this.ordersService.switchOverseasWarehouseOrderToChina(source, id);
  }

  @Get('china-orders')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async listChinaOrderProcessing(
    @Query('limit') limit?: string,
    @Query('scope') scope?: string,
  ): Promise<unknown[]> {
    return this.ordersService.listChinaOrderProcessing(limit, scope);
  }

  @Post('china-orders/sync-xiya-tracking')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async syncXiyaTrackingNumbers(): Promise<unknown> {
    return this.ordersService.syncXiyaTrackingNumbers();
  }

  @Get('overseas-warehouse/picking-batches')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async listOverseasPickingBatches(@Query('limit') limit?: string): Promise<unknown[]> {
    return this.ordersService.listOverseasPickingBatches(limit);
  }

  @Get('overseas-warehouse/picking-batches/:batchId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getOverseasPickingBatchDetail(@Param('batchId') batchId: string): Promise<unknown> {
    return this.ordersService.getOverseasPickingBatchDetail(batchId);
  }

  @Post('overseas-warehouse/picking-batches')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async createOverseasPickingBatch(
    @Body() payload: { items?: Array<{ source?: 'rakuten' | 'amazon'; id?: string | number }>; remark?: string },
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return this.ordersService.createOverseasPickingBatch(payload, user.id);
  }

  @Post('overseas-warehouse/picking-batches/:batchId/confirm')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async confirmOverseasPickingBatch(
    @Param('batchId') batchId: string,
    @Body() payload: { items?: Array<{ id?: string | number; actualQty?: string | number }> },
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return this.ordersService.confirmOverseasPickingBatch(batchId, payload, user.id);
  }

  @Post('overseas-warehouse/picking-batches/:batchId/scan')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async scanOverseasPickingBatchProduct(
    @Param('batchId') batchId: string,
    @Body() payload: { productId?: string },
  ): Promise<unknown> {
    return this.ordersService.scanOverseasPickingBatchProduct(batchId, payload);
  }

  @Post('overseas-warehouse/picking-batches/:batchId/products/:productId/switch-to-china')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async switchOverseasPickingBatchProductToChina(
    @Param('batchId') batchId: string,
    @Param('productId') productId: string,
  ): Promise<unknown> {
    return this.ordersService.switchOverseasPickingBatchProductToChina(batchId, productId);
  }

  @Post('overseas-warehouse/picking-batches/:batchId/products/:productId/reset-picking')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async resetOverseasPickingBatchProductPicking(
    @Param('batchId') batchId: string,
    @Param('productId') productId: string,
  ): Promise<unknown> {
    return this.ordersService.resetOverseasPickingBatchProductPicking(batchId, productId);
  }

  @Post('overseas-warehouse/picking-batches/:batchId/items/:itemId/switch-to-china')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async switchOverseasPickingBatchItemToChina(
    @Param('batchId') batchId: string,
    @Param('itemId') itemId: string,
  ): Promise<unknown> {
    return this.ordersService.switchOverseasPickingBatchItemToChina(batchId, itemId);
  }

  @Post('overseas-warehouse/picking-batches/:batchId/items/:itemId/reset-picking')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async resetOverseasPickingBatchItemPicking(
    @Param('batchId') batchId: string,
    @Param('itemId') itemId: string,
  ): Promise<unknown> {
    return this.ordersService.resetOverseasPickingBatchItemPicking(batchId, itemId);
  }

  @Post('overseas-warehouse/picking-batches/:batchId/items/:itemId/remove')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async removeOverseasPickingBatchItem(
    @Param('batchId') batchId: string,
    @Param('itemId') itemId: string,
  ): Promise<unknown> {
    return this.ordersService.removeOverseasPickingBatchItem(batchId, itemId);
  }

  @Post('overseas-warehouse/picking-batches/:batchId/yamato-export')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async exportOverseasPickingBatchYamatoImport(
    @Param('batchId') batchId: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.ordersService.buildOverseasPickingBatchYamatoImport(batchId);
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
    res.setHeader('X-Yamato-Batch-Id', file.batchId);
    res.status(200).send(file.content);
  }

  @Get('overseas-warehouse/yamato-batches')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async listYamatoShipmentBatches(@Query('limit') limit?: string): Promise<unknown[]> {
    return this.ordersService.listYamatoShipmentBatches(limit);
  }

  @Get('overseas-warehouse/yamato-print-config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  getYamatoShipmentPrintConfig(): unknown {
    return this.ordersService.getYamatoShipmentPrintConfig();
  }

  @Post('overseas-warehouse/yamato-export')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async exportOverseasWarehouseYamatoImport(
    @Body() payload: { items?: Array<{ source?: 'rakuten' | 'amazon'; id?: string | number }> },
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.ordersService.buildOverseasWarehouseYamatoImport(payload);
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
    res.setHeader('X-Yamato-Batch-Id', file.batchId);
    res.status(200).send(file.content);
  }

  @Post('rakuten/shipment-confirmation-csv')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async downloadRakutenShipmentConfirmationCsv(
    @Body() payload: { days?: string | number },
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.ordersService.buildRakutenShipmentConfirmationCsv(payload);
    res.setHeader('Content-Type', 'text/csv; charset=Shift_JIS');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    res.setHeader('Content-Length', String(file.content.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Rakuten-Shipment-Confirmation-Row-Count', String(file.rowCount));
    res.status(200).send(file.content);
  }

  @Post('overseas-warehouse/yamato-batches/:batchId/upload-pdf')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @UseInterceptors(AnyFilesInterceptor({ limits: { files: 20 } }))
  async uploadYamatoShipmentBatchPdf(
    @Param('batchId') batchId: string,
    @UploadedFiles() files: Array<{ buffer?: Buffer; originalname?: string }> | undefined,
  ): Promise<unknown> {
    const uploadedFiles = (files ?? []).filter((file) => file?.buffer);
    if (!uploadedFiles.length) {
      throw new BadRequestException('请选择 Yamato PDF 文件');
    }
    return this.ordersService.uploadYamatoShipmentBatchPdf(
      batchId,
      uploadedFiles.map((file) => ({
        buffer: file.buffer as Buffer,
        originalName: file.originalname,
      })),
    );
  }

  @Post('overseas-warehouse/yamato-batches/:batchId/print-by-product')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async printYamatoShipmentLabelByProductId(
    @Param('batchId') batchId: string,
    @Body() payload: { productId?: string },
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.ordersService.printYamatoShipmentLabelByProductId(batchId, payload);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    res.setHeader('Content-Length', String(file.content.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Yamato-Batch-Id', file.batchId);
    res.setHeader('X-Yamato-Page-No', String(file.pageNo));
    res.setHeader('X-Yamato-Tracking-No', file.trackingNo ?? '');
    res.setHeader('X-Yamato-Product-Id', file.productId);
    res.setHeader('X-Yamato-Remaining-Match-Count', String(file.remainingMatchCount));
    res.status(200).send(file.content);
  }

  @Post('overseas-warehouse/yamato-batches/:batchId/direct-print-by-product')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async directPrintYamatoShipmentLabelByProductId(
    @Param('batchId') batchId: string,
    @Body() payload: { productId?: string },
  ): Promise<unknown> {
    return this.ordersService.directPrintYamatoShipmentLabelByProductId(batchId, payload);
  }

  @Post('overseas-warehouse/yamato-batches/:batchId/queue-print-by-product')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async queueYamatoShipmentLabelByProductId(
    @Param('batchId') batchId: string,
    @Body() payload: { productId?: string },
  ): Promise<unknown> {
    return this.ordersService.queueYamatoShipmentLabelByProductId(batchId, payload);
  }

  @Post('amazon/delete-batch')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async deleteAmazonBatch(
    @Body() payload: { ids?: Array<string | number> },
  ): Promise<{ deletedCount: number }> {
    return this.ordersService.deleteAmazonBatch(payload);
  }

  @Post('amazon/shipment-confirmation-txt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async downloadAmazonShipmentConfirmationTxt(
    @Body() payload: { days?: string | number },
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.ordersService.buildAmazonShipmentConfirmationTxt(payload);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    res.setHeader('Content-Length', String(file.content.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Amazon-Shipment-Confirmation-Row-Count', String(file.rowCount));
    res.status(200).send(file.content);
  }

  @Post('delete-batch')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async deleteRakutenBatch(
    @Body() payload: { ids?: Array<string | number> },
  ): Promise<{ deletedCount: number }> {
    return this.ordersService.deleteRakutenBatch(payload);
  }

  @Post('rakuten/import-csv')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @UseInterceptors(FileInterceptor('file'))
  async importCsv(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
  ): Promise<unknown> {
    if (!file?.buffer) {
      throw new BadRequestException('请上传订单CSV文件');
    }
    return this.ordersService.importUploadedCsv(file.buffer, file.originalname);
  }

  @Post('amazon/import-txt')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @UseInterceptors(FileInterceptor('file'))
  async importAmazonTxt(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
  ): Promise<unknown> {
    if (!file?.buffer) {
      throw new BadRequestException('请选择亚马逊订单TXT文件');
    }
    return this.ordersService.importAmazonTxt(file.buffer, file.originalname);
  }

  @Get('export')
  @UseGuards(ThirdPartyApiKeyGuard)
  async export(@Res() res: Response): Promise<void> {
    const payload = await this.ordersService.exportForThirdParty();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  }

  @Post('export/ack')
  @UseGuards(ThirdPartyApiKeyGuard)
  async ackExport(
    @Body() payload: { items?: Array<{ source?: 'rakuten' | 'amazon'; id?: string | number }> },
  ): Promise<unknown> {
    return this.ordersService.ackThirdPartyExport(payload);
  }
}
