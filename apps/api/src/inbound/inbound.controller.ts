import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateInboundOrderDto } from './dto/create-inbound-order.dto';
import { QueryInboundOrdersDto } from './dto/query-inbound-orders.dto';
import { InboundService } from './inbound.service';

@Controller('inbound')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InboundController {
  constructor(private readonly inboundService: InboundService) {}

  @Get('orders')
  async list(@Query() query: QueryInboundOrdersDto): Promise<unknown[]> {
    return this.inboundService.list(query.status);
  }

  @Post('import-excel')
  @UseInterceptors(FileInterceptor('file'))
  async importExcel(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    if (!file?.buffer) {
      throw new BadRequestException('请上传文件');
    }
    return this.inboundService.importExcel(
      file.buffer,
      file.originalname,
      user.id,
      req.requestId,
    );
  }

  @Post('orders')
  async create(
    @Body() payload: CreateInboundOrderDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inboundService.create(payload, user.id, req.requestId);
  }

  @Post('orders/:id/confirm')
  async confirm(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inboundService.confirm(id, user.id, req.requestId);
  }

  @Post('orders/:id/void')
  async void(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: { requestId?: string },
  ): Promise<unknown> {
    return this.inboundService.void(id, user.id, req.requestId);
  }
}
