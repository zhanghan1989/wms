import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
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
import { CreateSkuDto } from './dto/create-sku.dto';
import { UpdateSkuDto } from './dto/update-sku.dto';
import { SkusService } from './skus.service';

@Controller('skus')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SkusController {
  constructor(private readonly skusService: SkusService) {}

  @Get()
  async list(
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    if (page || pageSize) {
      const pageNum = Number(page);
      const pageSizeNum = Number(pageSize);
      return this.skusService.listPage(q, pageNum, pageSizeNum);
    }
    return this.skusService.list(q);
  }

  @Get('upload-template')
  async downloadUploadTemplate(@Res() res: Response): Promise<void> {
    const file = await this.skusService.getUploadTemplate();
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

  @Get('export-excel')
  async exportExcel(@Res() res: Response): Promise<void> {
    const file = await this.skusService.exportExcel();
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

  @Get('export-unmatched-excel')
  async exportUnmatchedExcel(@Res() res: Response): Promise<void> {
    const file = await this.skusService.exportUnmatchedExcel();
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

  @Get('export-amazon-rb-link-stock-excel')
  async exportAmazonRbLinkStockExcel(@Res() res: Response): Promise<void> {
    const file = await this.skusService.exportAmazonRbLinkStockExcel();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    res.setHeader('Content-Length', String(file.content.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(file.content);
  }

  @Get('bulk-delete-template')
  async downloadBulkDeleteTemplate(@Res() res: Response): Promise<void> {
    const file = await this.skusService.getBulkDeleteTemplate();
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
  async create(
    @Body() payload: CreateSkuDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.skusService.create(payload, user.id, req.requestId);
  }

  @Post('import-excel')
  @UseInterceptors(FileInterceptor('file'))
  async importExcel(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    if (!file?.buffer) {
      throw new BadRequestException('请上传Excel文件');
    }
    return this.skusService.importExcel(
      file.buffer,
      file.originalname,
      user.id,
      req.requestId,
    );
  }

  @Post('bulk-delete-excel')
  @UseInterceptors(FileInterceptor('file'))
  async bulkDeleteExcel(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    if (!file?.buffer) {
      throw new BadRequestException('请上传Excel文件');
    }
    return this.skusService.importBulkDeleteExcel(
      file.buffer,
      file.originalname,
      user.id,
      req.requestId,
    );
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
