import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { BatchInboundService } from './batch-inbound.service';
import { CollectBatchInboundDto } from './dto/collect-batch-inbound.dto';
import {
  UpdateDomesticOrderNoDto,
  UpdateSeaOrderNoDto,
} from './dto/update-logistics-order-no.dto';

@Controller('batch-inbound')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BatchInboundController {
  constructor(private readonly batchInboundService: BatchInboundService) {}

  @Get('orders')
  async list(): Promise<unknown[]> {
    return this.batchInboundService.list();
  }

  @Get('orders/:id')
  async detail(@Param('id') id: string): Promise<unknown> {
    return this.batchInboundService.detail(id);
  }

  @Post('orders/collect')
  async collect(
    @Body() payload: CollectBatchInboundDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.batchInboundService.collect(payload, user.id, req.requestId);
  }

  @Post('orders/:id/upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Param('id') id: string,
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    if (!file?.buffer) {
      throw new BadRequestException('请上传文件');
    }
    return this.batchInboundService.upload(
      id,
      file.buffer,
      file.originalname,
      user.id,
      req.requestId,
    );
  }

  @Post('orders/:id/domestic-order-no')
  async updateDomesticOrderNo(
    @Param('id') id: string,
    @Body() payload: UpdateDomesticOrderNoDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.batchInboundService.updateDomesticOrderNo(
      id,
      payload.domesticOrderNo,
      user.id,
      req.requestId,
    );
  }

  @Post('orders/:id/sea-order-no')
  async updateSeaOrderNo(
    @Param('id') id: string,
    @Body() payload: UpdateSeaOrderNoDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.batchInboundService.updateSeaOrderNo(
      id,
      payload.seaOrderNo,
      user.id,
      req.requestId,
    );
  }

  @Post('orders/:id/confirm-all')
  async confirmAll(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.batchInboundService.confirmAll(id, user.id, req.requestId);
  }

  @Post('orders/:id/boxes/:boxCode/confirm')
  async confirmBox(
    @Param('id') id: string,
    @Param('boxCode') boxCode: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.batchInboundService.confirmBox(id, boxCode, user.id, req.requestId);
  }

  @Post('orders/:id/items/:itemId/confirm')
  async confirmItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.batchInboundService.confirmItem(id, itemId, user.id, req.requestId);
  }

  @Delete('orders/:id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<{ success: boolean }> {
    return this.batchInboundService.removeOrder(id, user.id, req.requestId);
  }
}
