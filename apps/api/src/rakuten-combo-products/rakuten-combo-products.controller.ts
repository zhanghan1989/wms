import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateRakutenComboProductDto } from './dto/create-rakuten-combo-product.dto';
import { RakutenComboProductsService } from './rakuten-combo-products.service';

@Controller('rakuten-combo-products')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RakutenComboProductsController {
  constructor(private readonly service: RakutenComboProductsService) {}

  @Get()
  async list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ): Promise<unknown> {
    return this.service.list(page, pageSize, keyword);
  }

  @Get('upload-template')
  async downloadUploadTemplate(@Res() res: Response): Promise<void> {
    const file = this.service.getUploadTemplate();
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

  @Post()
  async create(@Body() payload: CreateRakutenComboProductDto): Promise<unknown> {
    return this.service.create(payload);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() payload: CreateRakutenComboProductDto,
  ): Promise<unknown> {
    return this.service.update(id, payload);
  }

  @Post('import-excel')
  @UseInterceptors(FileInterceptor('file'))
  async importExcel(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
  ): Promise<unknown> {
    if (!file?.buffer) {
      throw new BadRequestException('请选择组合产品 Excel 文件');
    }
    return this.service.importExcel(file.buffer, file.originalname);
  }
}
