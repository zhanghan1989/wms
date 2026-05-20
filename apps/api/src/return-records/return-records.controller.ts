import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { ReturnRecordsService } from './return-records.service';

@Controller('return-records')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReturnRecordsController {
  constructor(private readonly returnRecordsService: ReturnRecordsService) {}

  @Get()
  async list(): Promise<unknown[]> {
    return this.returnRecordsService.list();
  }

  @Get('search')
  async search(@Query('q') query?: string): Promise<unknown> {
    return this.returnRecordsService.search(query);
  }

  @Get('search-suggestions')
  async searchSuggestions(@Query('q') query?: string): Promise<unknown[]> {
    return this.returnRecordsService.searchSuggestions(query);
  }

  @Post()
  async create(
    @Body() payload: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return this.returnRecordsService.create(payload, user.id);
  }

  @Post('import-excel')
  @UseInterceptors(FileInterceptor('file'))
  async importExcel(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    if (!file?.buffer) {
      throw new BadRequestException('请选择返品管理 Excel 文件');
    }
    return this.returnRecordsService.importExcel(file.buffer, file.originalname, user.id);
  }

  @Post('delete-batch')
  async deleteBatch(@Body() payload: { ids?: Array<string | number> }): Promise<unknown> {
    return this.returnRecordsService.deleteBatch(payload);
  }
}
