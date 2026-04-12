import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
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

  @Get('overseas-warehouse')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async listOverseasWarehouse(@Query('limit') limit?: string): Promise<unknown[]> {
    return this.ordersService.listOverseasWarehouse(limit);
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
    res.status(200).send(file.content);
  }

  @Post('amazon/delete-batch')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async deleteAmazonBatch(
    @Body() payload: { ids?: Array<string | number> },
  ): Promise<{ deletedCount: number }> {
    return this.ordersService.deleteAmazonBatch(payload);
  }

  @Post('delete-batch')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async deleteRakutenBatch(
    @Body() payload: { ids?: Array<string | number> },
  ): Promise<{ deletedCount: number }> {
    return this.ordersService.deleteRakutenBatch(payload);
  }

  @Post('import-csv')
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
}
